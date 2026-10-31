import { test, after } from "node:test";
import assert from "node:assert/strict";
import { call, launch, openTab, type Launched } from "./harness.ts";

const opened: Launched[] = [];
async function open() {
  const h = await launch();
  opened.push(h);
  return h;
}
after(async () => { for (const h of opened) await h.close(); });

const get = (h: Launched, key: string) => h.sw.evaluate((k) => chrome.storage.local.get(k).then((r) => r[k]), key);

async function optionsPage(h: Launched) {
  const page = await h.context.newPage();
  await page.goto(`chrome-extension://${new URL(h.sw.url()).host}/options.html`);
  return page;
}

test("t_migrate_allow: webop.allow becomes act grants and the old key is removed", async () => {
  const h = await open();
  await h.sw.evaluate(() => chrome.storage.local.set({ "webop.grants": {}, "webop.allow": ["localhost"] }));
  await h.sw.evaluate(() => (globalThis as any).__webop.migrateAllowList());
  assert.deepEqual(await get(h, "webop.grants"), { localhost: ["act"] });
  assert.equal(await get(h, "webop.allow"), undefined);
  const created = await call(h.sw, "tabs_create", { url: `${h.baseUrl}/button.html` });
  assert.ok("content" in created, "tabs_create should succeed");
  const tabId = JSON.parse((created as any).content[0].text).tab_id;
  assert.ok("content" in await call(h.sw, "computer", { action: "screenshot", tab_id: tabId }));
  const click = await call(h.sw, "computer", { tab_id: tabId, action: "left_click", coordinate: [10, 10] });
  assert.ok("content" in click, `left_click should succeed without a prompt: ${JSON.stringify(click)}`);
});

test("t_options_revoke: Revoke removes the site from webop.grants", async () => {
  const h = await open();
  await h.sw.evaluate(() => chrome.storage.local.set({ "webop.grants": { localhost: ["act"], "example.com": ["read"] } }));
  const page = await optionsPage(h);
  await page.locator('tr[data-site="example.com"] button.revoke').click();
  await page.locator('tr[data-site="example.com"]').waitFor({ state: "detached" });
  assert.deepEqual(await get(h, "webop.grants"), { localhost: ["act"] });
});

test("t_options_deny: deny list is normalised to the site key", async () => {
  const h = await open();
  const page = await optionsPage(h);
  await page.locator("#deny").fill("https://www.Example.com/x");
  await page.locator("#save-deny").click();
  await page.locator("#deny-status").filter({ hasText: "Saved" }).waitFor();
  assert.deepEqual(await get(h, "webop.deny"), ["example.com"]);
});

test("t_options_js_toggle: checkbox writes webop.js_enabled", async () => {
  const h = await open();
  const page = await optionsPage(h);
  await page.locator("#js-enabled").check();
  await page.waitForFunction(() => chrome.storage.local.get("webop.js_enabled").then((r) => r["webop.js_enabled"] === true));
  assert.equal(await get(h, "webop.js_enabled"), true);
});

const sw = <T>(h: Launched, fn: string, ...a: unknown[]): Promise<T> =>
  h.sw.evaluate(([f, args]) => (globalThis as any).__webop[f](...args), [fn, a] as const) as Promise<T>;

test("t_deny_beats_always: checkSite rejects a denied site despite a permanent act grant", async () => {
  const h = await open();
  await h.sw.evaluate(() => chrome.storage.local.set({ "webop.grants": { localhost: ["act"] }, "webop.deny": ["localhost"] }));
  await assert.rejects(sw(h, "checkSite", `${h.baseUrl}/button.html`), /permission_denied|not allowed/);
  await h.sw.evaluate(() => chrome.storage.local.set({ "webop.deny": [] }));
  await sw(h, "checkSite", `${h.baseUrl}/button.html`);
});

test("t_ready_gate: a read right after SW start sees migrated grants", async () => {
  const h = await open();
  await h.sw.evaluate(() => chrome.storage.local.set({ "webop.grants": {}, "webop.allow": ["localhost"] }));
  // rearm starts the migration; checkSite is called immediately without awaiting it.
  const ok = await h.sw.evaluate(async (u) => {
    const w = (globalThis as any).__webop;
    void w.rearmReady();
    try { await w.checkSite(u); return true; } catch { return false; }
  }, `${h.baseUrl}/button.html`);
  assert.equal(ok, true);
});

test("t_migrate_normalize: legacy entries are normalised, merged without clobbering, and idempotent", async () => {
  const h = await open();
  await h.sw.evaluate(() => chrome.storage.local.set({
    "webop.grants": { "keep.com": ["read"], "x.com": ["read"] },
    "webop.allow": ["https://www.X.com/path", "WWW.Y.com", "  ", "not a url ::"],
  }));
  await sw(h, "migrateAllowList");
  const expected = { "keep.com": ["read"], "x.com": ["read", "act"], "y.com": ["act"] };
  assert.deepEqual(await get(h, "webop.grants"), expected);
  assert.equal(await get(h, "webop.allow"), undefined);
  await sw(h, "migrateAllowList");
  assert.deepEqual(await get(h, "webop.grants"), expected);
});

test("t_once_revoked_on_close: a once grant disappears when its session closes", async () => {
  const h = await open();
  await openTab(h.sw, `${h.baseUrl}/button.html`, "s1");
  await sw(h, "grant", "s1", "example.com", "read", "once");
  const once = () => h.sw.evaluate(() => chrome.storage.session.get("webop.session_grants").then((r) => r["webop.session_grants"]));
  assert.deepEqual((await once() as any).s1, { "example.com": ["read"] });
  await sw(h, "closeSession", "s1");
  assert.equal((await once() as any)?.s1, undefined);
});

const promptPages = (h: Launched) => h.context.pages().filter((p) => p.url().includes("prompt.html"));
async function waitFor<T>(fn: () => T | undefined | false, what: string, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const askReq = { session_id: "s1", client_name: "claude-test", site: "localhost", level: "act" };

test("t_pending_notice: a gated call posts tool_pending with askMs + 10 s, then resets its deadline after the answer", async () => {
  const h = await open();
  await h.sw.evaluate(() => {
    const w = globalThis as any;
    w.__sent = [];
    w.__webop.setPendingSink((m: unknown) => w.__sent.push(m));
  });
  const done = h.sw.evaluate((r) => (globalThis as any).__webop.askInCall("s1", "c1", r), askReq);
  const popup = await waitFor(() => promptPages(h)[0], "prompt window");
  await popup.getByRole("button", { name: "本次允許" }).click();
  const r = await done as { answer: string; deadlineResetAfter: boolean };
  assert.equal(r.answer, "once");
  assert.equal(r.deadlineResetAfter, true);
  const sent = await h.sw.evaluate(() => (globalThis as any).__sent);
  assert.deepEqual(sent, [{ type: "tool_pending", id: "c1", session_id: "s1", extend_ms: 70_000 }]);
});

test("t_answer_after_cancel_noop: tool_cancel during the prompt closes the popup, denies, and nothing happens on the page", async () => {
  const h = await open();
  const tabId = await openTab(h.sw, `${h.baseUrl}/button.html`);
  const done = h.sw.evaluate((r) => (globalThis as any).__webop.askInCall("s1", "c2", r), askReq);
  await waitFor(() => promptPages(h)[0], "prompt window");
  await h.sw.evaluate(() => (globalThis as any).__webop.cancelCall("s1", "c2"));
  const r = await done as { answer: string };
  assert.equal(r.answer, "deny");
  await waitFor(() => promptPages(h).length === 0, "popup closed after tool_cancel");
  // A late cancel for a finished call is a no-op.
  await h.sw.evaluate(() => (globalThis as any).__webop.cancelCall("s1", "c2"));
  const page = h.context.pages().find((p) => p.url().includes("button.html"))!;
  assert.equal(await page.title(), "button");
  assert.ok(tabId > 0);
});
