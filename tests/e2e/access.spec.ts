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
  assert.ok(!("content" in r));
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
  assert.equal(errOf(r).code, "permission_denied");
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
