import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import { call, launch, openTab, type Launched } from "./harness.ts";

const opened: Launched[] = [];
async function open(grants: Record<string, string[]> = { localhost: ["act"] }, deny: string[] = []) {
  const h = await launch();
  opened.push(h);
  await h.sw.evaluate(([g, d]) => chrome.storage.local.set({ "webop.grants": g, "webop.deny": d }), [grants, deny] as const);
  return h;
}
after(async () => { for (const h of opened) await h.close(); });

type R = Awaited<ReturnType<typeof call>>;
const errOf = (r: R) => { assert.ok("error" in r, "expected an error"); return r.error; };
const textOf = (r: R): string => {
  assert.ok("content" in r, "error" in r ? `${r.error.code}: ${r.error.message}` : "no content");
  const t = r.content[0];
  assert.ok(t && t.type === "text");
  return t.text;
};

const promptPages = (h: Launched): Page[] => h.context.pages().filter((p) => p.url().includes("prompt.html"));
async function waitFor<T>(fn: () => T | undefined | false, what: string, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const popupOf = (h: Launched) => waitFor(() => promptPages(h)[0], "prompt window");
const noPopup = async (h: Launched) => { await new Promise((r) => setTimeout(r, 400)); assert.equal(promptPages(h).length, 0, "no prompt expected"); };
const tabUrl = (h: Launched, id: number) => h.sw.evaluate((i) => chrome.tabs.get(i).then((t) => t.url ?? ""), id);
const stored = (h: Launched, key: string) => h.sw.evaluate((k) => chrome.storage.local.get(k).then((r) => r[k]), key);

async function shotCenter(h: Launched, tab_id: number, session = "test"): Promise<[number, number]> {
  textOf(await call(h.sw, "computer", { action: "screenshot", tab_id }, session));
  const c = await h.sw.evaluate((t) => (globalThis as any).__webop.getContext(t), tab_id);
  return [Math.round(c.screenshotWidth / 2), Math.round(c.screenshotHeight / 2)];
}

test("t_navigate_asks_first: navigating to an ungranted site asks; deny leaves the tab where it was", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/button.html`);
  const r = call(h.sw, "navigate", { tab_id, url: `${h.altUrl}/form.html` });
  const popup = await popupOf(h);
  assert.equal(await popup.locator("#site").textContent(), "127.0.0.1");
  assert.equal(await popup.locator("#level").textContent(), "read");
  assert.equal(await tabUrl(h, tab_id), `${h.baseUrl}/button.html`);
  await popup.getByRole("button", { name: "拒絕" }).click();
  const e = errOf(await r);
  assert.equal(e.code, "permission_denied");
  assert.match(e.message, /Not performed|not started/i);
  assert.equal(await tabUrl(h, tab_id), `${h.baseUrl}/button.html`);
});

test("t_navigate_allow_once: allowing navigates and later reads of that site do not re-ask", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/button.html`);
  const r = call(h.sw, "navigate", { tab_id, url: `${h.altUrl}/form.html` });
  const popup = await popupOf(h);
  await popup.getByRole("button", { name: "本次允許" }).click();
  assert.match(textOf(await r), /127\.0\.0\.1.*form\.html/);
  textOf(await call(h.sw, "read_page", { tab_id }));
  await noPopup(h);
});

test("t_read_after_redirect_permission_required: click lands on an ungranted site -> permission_required, no image, prompt shown", async () => {
  const h = await open();
  const to = encodeURIComponent(`${h.altUrl}/button.html`);
  const tab_id = await openTab(h.sw, `${h.baseUrl}/link.html?to=${to}`);
  const [x, y] = [50, 50];
  textOf(await call(h.sw, "computer", { action: "screenshot", tab_id }));
  const r = await call(h.sw, "computer", { action: "left_click", coordinate: [x, y], tab_id });
  const e = errOf(r);
  assert.equal(e.code, "permission_required");
  assert.match(e.message, /WAS performed/);
  const popup = await popupOf(h);
  assert.equal(await popup.locator("#site").textContent(), "127.0.0.1");
  await popup.getByRole("button", { name: "本次允許" }).click();
  await waitFor(() => promptPages(h).length === 0, "popup closed");
  // The user's approval makes the retry work.
  textOf(await call(h.sw, "read_page", { tab_id }));
});

test("t_deny_list_no_prompt: a denied site fails at once without a popup", async () => {
  const h = await open({ localhost: ["act"] }, ["127.0.0.1"]);
  const r = await call(h.sw, "tabs_create", { url: `${h.altUrl}/button.html` });
  const e = errOf(r);
  assert.equal(e.code, "permission_denied");
  assert.match(e.message, /deny list/);
  await noPopup(h);
});

test("t_site_changed_before_input: the tab moving to another site after authorization -> security_check_failed, nothing sent", async () => {
  const h = await open({ localhost: ["act"], "127.0.0.1": ["act"] });
  const tab_id = await openTab(h.sw, `${h.baseUrl}/button.html`);
  const [x, y] = await shotCenter(h, tab_id);
  const page = h.context.pages().find((p) => p.url() === `${h.baseUrl}/button.html`);
  assert.ok(page);
  await h.sw.evaluate((u) => {
    (globalThis as any).__webop.devHooks.afterTarget = async (id: number) => {
      (globalThis as any).__webop.devHooks.afterTarget = undefined;
      await chrome.tabs.update(id, { url: u });
      await new Promise((r) => setTimeout(r, 800));
    };
  }, `${h.altUrl}/button.html`);
  const e = errOf(await call(h.sw, "computer", { action: "left_click", coordinate: [x, y], tab_id }));
  assert.equal(e.code, "security_check_failed");
  assert.ok(e.message.startsWith("Not performed"), e.message);
  assert.match(e.message, /localhost.*127\.0\.0\.1/);
  assert.equal(await page.title(), "button");
});

test("t_tabs_list_hides_unreadable: ungranted and read-granted tabs", async () => {
  const h = await open();
  await openTab(h.sw, `${h.baseUrl}/button.html`);
  await openTab(h.sw, `${h.altUrl}/button.html`);
  const listed = JSON.parse(textOf(await call(h.sw, "tabs_list", {})));
  assert.equal(listed.length, 2);
  assert.ok(listed.some((t: any) => t.url.startsWith(h.baseUrl)));
  const hidden = listed.find((t: any) => !t.url.startsWith(h.baseUrl));
  assert.deepEqual({ title: hidden.title, url: hidden.url }, { title: "", url: "(site not allowed)" });
  await h.sw.evaluate(() => chrome.storage.local.set({ "webop.grants": { localhost: ["act"], "127.0.0.1": ["read"] } }));
  const after = JSON.parse(textOf(await call(h.sw, "tabs_list", {})));
  assert.ok(after.every((t: any) => t.url !== "(site not allowed)"));
});

test("t_act_prompt_once: left_click on a read-only site asks for act; allow once clicks, no re-ask; new session re-asks", async () => {
  const h = await open({ localhost: ["act"], "127.0.0.1": ["read"] });
  const tab_id = await openTab(h.sw, `${h.altUrl}/button.html`);
  const [x, y] = await shotCenter(h, tab_id);
  const page = h.context.pages().find((p) => p.url() === `${h.altUrl}/button.html`);
  assert.ok(page);
  const r1 = call(h.sw, "computer", { action: "left_click", coordinate: [x, y], tab_id });
  const popup = await popupOf(h);
  assert.equal(await popup.locator("#level").textContent(), "act");
  await popup.getByRole("button", { name: "本次允許" }).click();
  textOf(await r1);
  assert.equal(await page.title(), "clicked:true");
  await page.evaluate(() => { document.title = "reset"; });
  textOf(await call(h.sw, "computer", { action: "left_click", coordinate: [x, y], tab_id }));
  assert.equal(await page.title(), "clicked:true");
  await noPopup(h);
  assert.equal(((await stored(h, "webop.grants")) as any)["127.0.0.1"].includes("act"), false);
  // A different session does not inherit once-grants.
  await h.sw.evaluate((id) => (globalThis as any).__webop.adoptTab("other", id), tab_id);
  await h.sw.evaluate(() => (globalThis as any).__webop.closeSession("test"));
  await page.evaluate(() => { document.title = "reset"; });
  const r2 = call(h.sw, "computer", { action: "left_click", coordinate: [x, y], tab_id }, "other");
  const popup2 = await popupOf(h);
  await popup2.getByRole("button", { name: "拒絕" }).click();
  assert.equal(errOf(await r2).code, "permission_denied");
  assert.equal(await page.title(), "reset");
});

test("t_act_prompt_always: 永久允許 persists to webop.grants", async () => {
  const h = await open({ localhost: ["act"], "127.0.0.1": ["read"] });
  const tab_id = await openTab(h.sw, `${h.altUrl}/button.html`);
  const [x, y] = await shotCenter(h, tab_id);
  const r = call(h.sw, "computer", { action: "left_click", coordinate: [x, y], tab_id });
  const popup = await popupOf(h);
  await popup.getByRole("button", { name: "永久允許" }).click();
  textOf(await r);
  assert.ok(((await stored(h, "webop.grants")) as any)["127.0.0.1"].includes("act"));
});

test("t_act_prompt_deny: deny -> permission_denied, page untouched", async () => {
  const h = await open({ localhost: ["act"], "127.0.0.1": ["read"] });
  const tab_id = await openTab(h.sw, `${h.altUrl}/button.html`);
  const [x, y] = await shotCenter(h, tab_id);
  const page = h.context.pages().find((p) => p.url() === `${h.altUrl}/button.html`);
  assert.ok(page);
  const r = call(h.sw, "computer", { action: "left_click", coordinate: [x, y], tab_id });
  const popup = await popupOf(h);
  await popup.getByRole("button", { name: "拒絕" }).click();
  const e = errOf(await r);
  assert.equal(e.code, "permission_denied");
  assert.match(e.message, /Not performed/);
  assert.equal(await page.title(), "button");
});

/** Fails fast (instead of hanging for the whole prompt timeout) when a call that must not block does. */
const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} did not return within ${ms} ms`)), ms))]);

/** The user (not the agent) moves the tab to `url` and the load finishes. */
const userNavigates = (h: Launched, tabId: number, url: string) => h.sw.evaluate(([i, u]) => new Promise<void>((resolve) => {
  const on = (id: number, info: { status?: string }) => {
    if (id === i && info.status === "complete") { chrome.tabs.onUpdated.removeListener(on); resolve(); }
  };
  chrome.tabs.onUpdated.addListener(on);
  void chrome.tabs.update(i, { url: u });
}), [tabId, url] as const);

const sessionGrants = (h: Launched) => h.sw.evaluate(() => chrome.storage.session.get("webop.session_grants").then((r) => r["webop.session_grants"] ?? {}));
const tabCount = (h: Launched) => h.sw.evaluate(() => chrome.tabs.query({}).then((t) => t.filter((x) => !(x.url ?? x.pendingUrl ?? "").includes("prompt.html")).length));

test("t_ask_gate_before_page_contact: a declined act prompt leaves the page untouched (no scroll) for ref targets and scroll_to", async () => {
  const h = await open({ localhost: ["act"], "127.0.0.1": ["read"] });
  const tab_id = await openTab(h.sw, `${h.altUrl}/ax.html`);
  const page = h.context.pages().find((p) => p.url() === `${h.altUrl}/ax.html`);
  assert.ok(page);
  const text = textOf(await call(h.sw, "read_page", { tab_id }));
  const ref = /button "Far away" \[(ref_\d+)\]/.exec(text)?.[1];
  assert.ok(ref, text);
  for (const action of ["left_click", "scroll_to"]) {
    const r = call(h.sw, "computer", { action, tab_id, ref });
    const popup = await popupOf(h);
    assert.equal(await popup.locator("#level").textContent(), "act");
    assert.equal(await page.evaluate(() => scrollY), 0, `${action}: scrolled before the user answered`);
    await popup.getByRole("button", { name: "拒絕" }).click();
    const e = errOf(await r);
    assert.equal(e.code, "permission_denied");
    assert.match(e.message, /Not performed/);
    assert.equal(await page.evaluate(() => scrollY), 0, `${action}: scrolled although the user declined`);
    await waitFor(() => promptPages(h).length === 0, "popup closed");
  }
});

test("t_prompt_keeps_screenshot_context: the prompt's own screenshot does not replace the agent's context", async () => {
  const h = await open({ localhost: ["act"], "127.0.0.1": ["read"] });
  const tab_id = await openTab(h.sw, `${h.altUrl}/button.html`);
  const [x, y] = await shotCenter(h, tab_id);
  await h.sw.evaluate((t) => { (globalThis as any).__ctxBefore = (globalThis as any).__webop.getContext(t); }, tab_id);
  const r = call(h.sw, "computer", { action: "left_click", coordinate: [x, y], tab_id });
  const popup = await popupOf(h);
  await popup.getByRole("button", { name: "拒絕" }).click();
  errOf(await r);
  assert.equal(await h.sw.evaluate((t) => (globalThis as any).__webop.getContext(t) === (globalThis as any).__ctxBefore, tab_id), true);
});

test("t_tabs_create_redirect_to_ask_site: the tab is closed, permission_required, prompt shown", async () => {
  const h = await open();
  const before = await tabCount(h);
  const to = encodeURIComponent(`${h.altUrl}/button.html`);
  const e = errOf(await call(h.sw, "tabs_create", { url: `${h.baseUrl}/redirect.html?to=${to}` }));
  assert.equal(e.code, "permission_required");
  const popup = await popupOf(h);
  assert.equal(await popup.locator("#site").textContent(), "127.0.0.1");
  assert.equal(await tabCount(h), before);
});

test("t_history_into_ask_site: back into an ungranted entry asks before loading; deny does not navigate", async () => {
  const h = await open({ localhost: ["act"], "127.0.0.1": ["read"] });
  const tab_id = await openTab(h.sw, `${h.altUrl}/button.html`);
  textOf(await call(h.sw, "navigate", { tab_id, url: `${h.baseUrl}/form.html` }));
  await h.sw.evaluate(() => chrome.storage.local.set({ "webop.grants": { localhost: ["act"] } }));
  const r = call(h.sw, "navigate", { tab_id, url: "back" });
  const popup = await popupOf(h);
  assert.equal(await popup.locator("#site").textContent(), "127.0.0.1");
  assert.equal(await tabUrl(h, tab_id), `${h.baseUrl}/form.html`);
  await popup.getByRole("button", { name: "拒絕" }).click();
  assert.equal(errOf(await r).code, "permission_denied");
  assert.equal(await tabUrl(h, tab_id), `${h.baseUrl}/form.html`);
});

test("t_reads_on_ask_site_do_not_block: read_page and screenshot -> permission_required at once, one prompt", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/button.html`);
  await userNavigates(h, tab_id, `${h.altUrl}/button.html`);
  const e1 = errOf(await within(call(h.sw, "read_page", { tab_id }), 8000, "read_page"));
  assert.equal(e1.code, "permission_required");
  assert.match(e1.message, /has not been allowed to read/);
  const popup = await popupOf(h);
  assert.equal(await popup.locator("#level").textContent(), "read");
  const e2 = errOf(await within(call(h.sw, "computer", { action: "screenshot", tab_id }), 8000, "screenshot"));
  assert.equal(e2.code, "permission_required");
  assert.equal(promptPages(h).length, 1);
  await popup.getByRole("button", { name: "本次允許" }).click();
  await waitFor(() => promptPages(h).length === 0, "popup closed");
  textOf(await call(h.sw, "read_page", { tab_id }));
});

test("t_key_after_user_navigation_asks_act: key on an ungranted site asks before anything is sent", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/form.html`);
  await userNavigates(h, tab_id, `${h.altUrl}/form.html`);
  const r1 = call(h.sw, "computer", { action: "key", text: "a", tab_id });
  const p1 = await popupOf(h);
  assert.equal(await p1.locator("#level").textContent(), "act");
  await p1.getByRole("button", { name: "拒絕" }).click();
  assert.equal(errOf(await r1).code, "permission_denied");
  await waitFor(() => promptPages(h).length === 0, "popup closed");
  const r2 = call(h.sw, "computer", { action: "key", text: "a", tab_id });
  const p2 = await popupOf(h);
  await p2.getByRole("button", { name: "本次允許" }).click();
  textOf(await r2);
});

test("t_navigate_final_url_on_ask_site: a granted URL that redirects to an ungranted site -> permission_required", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/button.html`);
  const to = encodeURIComponent(`${h.altUrl}/button.html`);
  const e = errOf(await within(call(h.sw, "navigate", { tab_id, url: `${h.baseUrl}/redirect.html?to=${to}` }), 15_000, "navigate"));
  assert.equal(e.code, "permission_required");
  assert.match(e.message, /WAS performed|now on/);
  await popupOf(h);
});

test("t_cancel_during_prompt: cancelling while the popup is open -> timeout Not performed, nothing stored, popup closed", async () => {
  const h = await open({ localhost: ["act"], "127.0.0.1": ["read"] });
  const tab_id = await openTab(h.sw, `${h.altUrl}/button.html`);
  const [x, y] = await shotCenter(h, tab_id);
  const page = h.context.pages().find((p) => p.url() === `${h.altUrl}/button.html`);
  assert.ok(page);
  const run = h.sw.evaluate(([t, c]) => (globalThis as any).__webop.dispatch({ id: "c1", session_id: "test", tool: "computer", args: { action: "left_click", tab_id: t, coordinate: c } }), [tab_id, [x, y]] as const);
  await popupOf(h);
  await h.sw.evaluate(() => (globalThis as any).__webop.cancelCall("test", "c1"));
  const e = errOf(await run as R);
  assert.equal(e.code, "timeout");
  assert.match(e.message, /^Not performed/);
  await waitFor(() => promptPages(h).length === 0, "popup closed");
  assert.equal(((await stored(h, "webop.grants")) as any)["127.0.0.1"].includes("act"), false);
  assert.deepEqual(JSON.stringify(await sessionGrants(h)).includes("act"), false);
  assert.equal(await page.title(), "button");
});

test("t_tab_moves_during_prompt: allowing after the tab went elsewhere -> security_check_failed, no input", async () => {
  const h = await open({ localhost: ["act"], "127.0.0.1": ["read"] });
  const tab_id = await openTab(h.sw, `${h.altUrl}/button.html`);
  const [x, y] = await shotCenter(h, tab_id);
  const r = call(h.sw, "computer", { action: "left_click", coordinate: [x, y], tab_id });
  const popup = await popupOf(h);
  await userNavigates(h, tab_id, `${h.baseUrl}/button.html`);
  await popup.getByRole("button", { name: "本次允許" }).click();
  const e = errOf(await r);
  assert.equal(e.code, "security_check_failed");
  assert.match(e.message, /^Not performed/);
  const page = h.context.pages().find((p) => p.url() === `${h.baseUrl}/button.html`);
  assert.ok(page);
  assert.equal(await page.title(), "button");
});

test("t_background_ask_dies_with_session: closing the session closes the popup and stores no grant", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/button.html`);
  await userNavigates(h, tab_id, `${h.altUrl}/button.html`);
  errOf(await call(h.sw, "read_page", { tab_id }));
  const popup = await popupOf(h);
  await h.sw.evaluate(() => (globalThis as any).__webop.closeSession("test"));
  await waitFor(() => promptPages(h).length === 0, "popup closed with the session");
  assert.equal(JSON.stringify(await sessionGrants(h)).includes("127.0.0.1"), false);
  assert.equal(popup.isClosed(), true);
});

test("t_pending_navigation_counts_as_moved: a cross-site navigation already in flight before input -> security_check_failed", async () => {
  const h = await open({ localhost: ["act"], "127.0.0.1": ["act"] });
  const tab_id = await openTab(h.sw, `${h.baseUrl}/button.html`);
  const [x, y] = await shotCenter(h, tab_id);
  await h.sw.evaluate((u) => {
    (globalThis as any).__webop.devHooks.afterTarget = async (id: number) => {
      (globalThis as any).__webop.devHooks.afterTarget = undefined;
      void chrome.tabs.update(id, { url: u });
      await new Promise((r) => setTimeout(r, 5));
    };
  }, `${h.altUrl}/button.html`);
  const e = errOf(await call(h.sw, "computer", { action: "left_click", coordinate: [x, y], tab_id }));
  assert.equal(e.code, "security_check_failed");
});

test("t_denied_wording_reflects_cause: javascript switched off is not reported as the deny list", async () => {
  const h = await open();
  const msg = await h.sw.evaluate(async (u) => {
    try {
      await (globalThis as any).__webop.requireAccess({ session_id: "test", client_name: "t", url: u, level: "javascript" });
      return "no error";
    } catch (e: any) { return String(e.message); }
  }, `${h.baseUrl}/button.html`);
  assert.match(msg, /JavaScript.*(disabled|off)/i);
  assert.doesNotMatch(msg, /deny list/);
});
