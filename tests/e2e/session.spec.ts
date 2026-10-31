import { test, after } from "node:test";
import assert from "node:assert/strict";
import { call, launch, openForeignTab, type Launched } from "./harness.ts";
import type { Worker } from "@playwright/test";

const opened: Launched[] = [];
async function open() {
  const h = await launch();
  opened.push(h);
  // These tests treat the second origin as a refused site (ask flows live in access.spec.ts).
  await h.sw.evaluate(() => chrome.storage.local.set({ "webop.deny": ["127.0.0.1"] }));
  return h;
}
after(async () => { for (const h of opened) await h.close(); });

type R = Awaited<ReturnType<typeof call>>;
function textOf(r: R): string {
  assert.ok("content" in r, "error" in r ? `${r.error.code}: ${r.error.message}` : "no content");
  const t = r.content[0];
  assert.ok(t && t.type === "text");
  return t.text;
}
function errOf(r: R) {
  assert.ok("error" in r, "expected an error");
  return r.error;
}
async function create(sw: Worker, url: string, session = "test"): Promise<number> {
  return JSON.parse(textOf(await call(sw, "tabs_create", { url }, session))).tab_id;
}
async function waitForUrl(sw: Worker, tabId: number, host: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const url = await sw.evaluate((id) => chrome.tabs.get(id).then((t) => t.url ?? ""), tabId);
    if (new URL(url).hostname === host) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`tab never reached ${host}`);
}

test("tabs_create opens background tab in session group", async () => {
  const { sw, baseUrl } = await open();
  const tab_id = await create(sw, `${baseUrl}/button.html`);
  const info = await sw.evaluate(async (id) => {
    const t = await chrome.tabs.get(id);
    const g = await chrome.tabGroups.get(t.groupId);
    return { active: t.active, title: g.title, color: g.color };
  }, tab_id);
  assert.equal(info.active, false);
  assert.equal(info.title, "webop · test");
  assert.equal(info.color, "blue");
});

test("group colors rotate per session and tabs share their session's group", async () => {
  const { sw, baseUrl } = await open();
  const a = await create(sw, `${baseUrl}/button.html`, "a");
  const a2 = await create(sw, `${baseUrl}/button.html`, "a");
  const b = await create(sw, `${baseUrl}/button.html`, "b");
  const [ga, ga2, gb] = await sw.evaluate(async (ids) => Promise.all(ids.map(async (id) => {
    const t = await chrome.tabs.get(id);
    return { id: t.groupId, color: (await chrome.tabGroups.get(t.groupId)).color };
  })), [a, a2, b]);
  assert.equal(ga.id, ga2.id);
  assert.notEqual(ga.id, gb.id);
  assert.deepEqual([ga.color, gb.color], ["blue", "purple"]);
});

test("tabs_list only own tabs", async () => {
  const { sw, baseUrl } = await open();
  await openForeignTab(sw, `${baseUrl}/form.html`);
  const own = await create(sw, `${baseUrl}/button.html`);
  const tabs = JSON.parse(textOf(await call(sw, "tabs_list", {})));
  assert.deepEqual(tabs.map((t: { tab_id: number }) => t.tab_id), [own]);
  assert.ok(tabs[0].url.endsWith("/button.html"));
});

test("foreign tab -> tab_not_in_session", async () => {
  const { sw, baseUrl } = await open();
  const foreign = await openForeignTab(sw, `${baseUrl}/button.html`);
  for (const [tool, args] of [
    ["read_page", { tab_id: foreign }],
    ["computer", { action: "screenshot", tab_id: foreign }],
    ["navigate", { tab_id: foreign, url: `${baseUrl}/form.html` }],
    ["tabs_close", { tab_id: foreign }],
  ] as const) {
    assert.equal(errOf(await call(sw, tool, args)).code, "tab_not_in_session", tool);
  }
  // another session cannot use a tab owned by "test" either
  const own = await create(sw, `${baseUrl}/button.html`);
  assert.equal(errOf(await call(sw, "read_page", { tab_id: own }, "other")).code, "tab_not_in_session");
});

test("tabs_create to non-allowlisted or non-web url is denied", async () => {
  const { sw, altUrl } = await open();
  const e = errOf(await call(sw, "tabs_create", { url: `${altUrl}/button.html` }));
  assert.equal(e.code, "permission_denied");
  assert.match(e.message, /127\.0\.0\.1/);
  assert.match(e.message, /deny list in webop options/);
  assert.equal(errOf(await call(sw, "tabs_create", { url: "chrome://version" })).code, "permission_denied");
  assert.equal(errOf(await call(sw, "tabs_create", { url: "about:blank" })).code, "permission_denied");
  assert.deepEqual(JSON.parse(textOf(await call(sw, "tabs_list", {}))), []);
});

test("navigate to non-allowlisted site denied, url unchanged", async () => {
  const { sw, baseUrl, altUrl } = await open();
  const tab_id = await create(sw, `${baseUrl}/button.html`);
  assert.equal(errOf(await call(sw, "navigate", { tab_id, url: `${altUrl}/button.html` })).code, "permission_denied");
  const url = await sw.evaluate((id) => chrome.tabs.get(id).then((t) => t.url), tab_id);
  assert.equal(url, `${baseUrl}/button.html`);
});

test("navigate within allowlist, back and forward", async () => {
  const { sw, baseUrl } = await open();
  const tab_id = await create(sw, `${baseUrl}/button.html`);
  assert.match(textOf(await call(sw, "navigate", { tab_id, url: `${baseUrl}/form.html` })), /form\.html/);
  assert.match(textOf(await call(sw, "navigate", { tab_id, url: "back" })), /button\.html/);
  assert.match(textOf(await call(sw, "navigate", { tab_id, url: "forward" })), /form\.html/);
  assert.equal(errOf(await call(sw, "navigate", { tab_id, url: "forward" })).code, "invalid_args");
});

test("read after redirect to other site denied", async () => {
  const { sw, baseUrl, altUrl } = await open();
  const tab_id = await create(sw, `${baseUrl}/button.html`);
  const to = encodeURIComponent(`${altUrl}/button.html`);
  await call(sw, "navigate", { tab_id, url: `${baseUrl}/redirect.html?to=${to}` });
  await waitForUrl(sw, tab_id, "127.0.0.1");
  const e = errOf(await call(sw, "read_page", { tab_id }));
  assert.equal(e.code, "permission_denied");
  const listed = JSON.parse(textOf(await call(sw, "tabs_list", {})));
  assert.equal(listed[0].title, "");
  assert.ok(!listed[0].url.includes("127.0.0.1"));
});

test("screenshot and actions after redirect denied", async () => {
  const { sw, baseUrl, altUrl } = await open();
  const tab_id = await create(sw, `${baseUrl}/button.html`);
  const to = encodeURIComponent(`${altUrl}/button.html`);
  await call(sw, "navigate", { tab_id, url: `${baseUrl}/redirect.html?to=${to}` });
  await waitForUrl(sw, tab_id, "127.0.0.1");
  for (const args of [{ action: "screenshot" }, { action: "key", text: "a" }, { action: "left_click", coordinate: [5, 5] }]) {
    const r = await call(sw, "computer", { ...args, tab_id });
    assert.equal(errOf(r).code, "permission_denied", JSON.stringify(args));
    assert.ok(!("content" in r));
  }
});

test("tabs_close removes an owned tab", async () => {
  const { sw, baseUrl } = await open();
  const tab_id = await create(sw, `${baseUrl}/button.html`);
  textOf(await call(sw, "tabs_close", { tab_id }));
  assert.equal(await sw.evaluate((id) => chrome.tabs.get(id).then(() => true, () => false), tab_id), false);
  assert.deepEqual(JSON.parse(textOf(await call(sw, "tabs_list", {}))), []);
});

test("session close detaches but keeps tab", async () => {
  const { sw, baseUrl } = await open();
  const tab_id = await create(sw, `${baseUrl}/button.html`);
  assert.ok("content" in await call(sw, "computer", { action: "screenshot", tab_id }));
  // Attaching again only succeeds if the extension no longer holds the debugger (Playwright's own client does not conflict).
  const canAttach = () => sw.evaluate(async (id) => {
    try { await chrome.debugger.attach({ tabId: id }, "1.3"); } catch { return false; }
    await chrome.debugger.detach({ tabId: id });
    return true;
  }, tab_id);
  assert.equal(await canAttach(), false, "attached after screenshot");
  await sw.evaluate(() => (globalThis as any).__webop.closeSession("test"));
  assert.equal(await canAttach(), true, "still attached after closeSession");
  assert.equal(await sw.evaluate((id) => chrome.tabs.get(id).then(() => true, () => false), tab_id), true);
  assert.equal(errOf(await call(sw, "read_page", { tab_id })).code, "tab_not_in_session");
});

test("session ownership is persisted in chrome.storage.session", async () => {
  const { sw, baseUrl } = await open();
  const tab_id = await create(sw, `${baseUrl}/button.html`);
  const stored = await sw.evaluate(() => chrome.storage.session.get("webop.sessions"));
  assert.deepEqual((stored["webop.sessions"] as any).sessions.test.tabIds, [tab_id]);
});

test("action that navigates cross-site returns permission_denied without an image", async () => {
  const { sw, baseUrl, altUrl } = await open();
  const to = encodeURIComponent(`${altUrl}/button.html`);
  const tab_id = await create(sw, `${baseUrl}/link.html?to=${to}`);
  assert.ok("content" in await call(sw, "computer", { action: "screenshot", tab_id }));
  const r = await call(sw, "computer", { action: "left_click", coordinate: [50, 50], tab_id });
  const e = errOf(r);
  assert.equal(e.code, "permission_denied");
  assert.match(e.message, /WAS performed/);
  assert.ok(!("content" in r));
  assert.equal(new URL(await sw.evaluate((id) => chrome.tabs.get(id).then((t) => t.url ?? ""), tab_id)).hostname, "127.0.0.1");
});

test("forward into a denied history entry is refused before loading", async () => {
  const { sw, baseUrl, altUrl } = await open();
  const tab_id = await create(sw, `${baseUrl}/button.html`);
  // Build history allowed -> denied -> allowed through the page itself (the navigate tool would refuse the middle hop).
  await sw.evaluate(async ([id, u]) => { await chrome.tabs.update(id, { url: u }); }, [tab_id, `${altUrl}/button.html`] as const);
  await waitForUrl(sw, tab_id, "127.0.0.1");
  await sw.evaluate(async ([id, u]) => { await chrome.tabs.update(id, { url: u }); }, [tab_id, `${baseUrl}/form.html`] as const);
  await waitForUrl(sw, tab_id, "localhost");
  const url = () => sw.evaluate((id) => chrome.tabs.get(id).then((t) => t.url ?? ""), tab_id);
  // back from form.html targets the denied entry
  assert.equal(errOf(await call(sw, "navigate", { tab_id, url: "back" })).code, "permission_denied");
  assert.equal(await url(), `${baseUrl}/form.html`);
  // jump to the first (allowed) entry, then forward targets the denied entry
  await sw.evaluate(async (id) => {
    const send = (globalThis as any).__webop.send;
    const h = await send(id, "Page.getNavigationHistory");
    await send(id, "Page.navigateToHistoryEntry", { entryId: h.entries[0].id });
  }, tab_id);
  await sw.evaluate(() => new Promise((r) => setTimeout(r, 500)));
  assert.equal(await url(), `${baseUrl}/button.html`);
  assert.equal(errOf(await call(sw, "navigate", { tab_id, url: "forward" })).code, "permission_denied");
  assert.equal(await url(), `${baseUrl}/button.html`);
});

test("tabs_create that redirects to a denied site closes the tab", async () => {
  const { sw, baseUrl, altUrl } = await open();
  const to = encodeURIComponent(`${altUrl}/button.html`);
  const e = errOf(await call(sw, "tabs_create", { url: `${baseUrl}/redirect.html?to=${to}` }));
  assert.equal(e.code, "permission_denied");
  assert.deepEqual(JSON.parse(textOf(await call(sw, "tabs_list", {}))), []);
  assert.equal(await sw.evaluate(() => chrome.tabs.query({}).then((ts) => ts.filter((t) => (t.url ?? "").includes("127.0.0.1") || (t.pendingUrl ?? "").includes("127.0.0.1")).length)), 0);
});

test("concurrent screenshots on one tab are serialized (hide/capture/unhide never interleave)", async () => {
  const { sw, baseUrl } = await open();
  const tab_id = await create(sw, `${baseUrl}/button.html`);
  await sw.evaluate(() => { (globalThis as any).__webop.hiderLog.length = 0; });
  const results = await Promise.all([1, 2, 3].map(() => call(sw, "computer", { action: "screenshot", tab_id })));
  for (const r of results) assert.ok("content" in r, "error" in r ? r.error.message : "");
  const log: Array<{ hidden?: boolean; at?: string }> = await sw.evaluate(() => JSON.parse(JSON.stringify((globalThis as any).__webop.hiderLog)));
  const one = ["hidden:true", "before", "after", "hidden:false"];
  assert.deepEqual(log.map((e) => e.hidden === undefined ? e.at : `hidden:${e.hidden}`), [...one, ...one, ...one]);
});

async function canAttach(sw: Worker, tab_id: number): Promise<boolean> {
  return sw.evaluate(async (id) => {
    try { await chrome.debugger.attach({ tabId: id }, "1.3"); } catch { return false; }
    await chrome.debugger.detach({ tabId: id });
    return true;
  }, tab_id);
}

test("session closed during an in-flight screenshot: no debugger left behind, later calls fail", async () => {
  const { sw, baseUrl } = await open();
  const tab_id = await create(sw, `${baseUrl}/button.html`);
  await sw.evaluate(() => { (globalThis as any).__webop.hiderLog.length = 0; });
  // Start the screenshot, and close the session as soon as it has begun hiding the overlay (i.e. after attaching).
  const inflight = call(sw, "computer", { action: "screenshot", tab_id });
  await sw.evaluate(async () => {
    const w = (globalThis as any).__webop;
    for (let i = 0; i < 500 && w.hiderLog.length === 0; i++) await new Promise((r) => setTimeout(r, 2));
    await w.closeSession("test");
  });
  const r = await inflight;
  assert.equal(errOf(r).code, "tab_not_in_session");
  assert.match(errOf(r).message, /closed/);
  assert.equal(await canAttach(sw, tab_id), true, "debugger still attached after close");
  // The closed id is not resurrected by a later call.
  for (const [tool, args] of [["computer", { action: "screenshot", tab_id }], ["read_page", { tab_id }], ["tabs_list", {}], ["tabs_create", { url: `${baseUrl}/form.html` }]] as const) {
    const e = errOf(await call(sw, tool, args));
    assert.equal(e.code, "tab_not_in_session", tool);
    assert.match(e.message, /closed/, tool);
  }
  assert.equal(await canAttach(sw, tab_id), true, "debugger attached by a call after close");
});

test("closing a session hides the cursor and glow on its tabs", async () => {
  const { sw, baseUrl, context } = await open();
  const tab_id = await create(sw, `${baseUrl}/button.html`);
  const page = context.pages().find((p) => p.url() === `${baseUrl}/button.html`);
  assert.ok(page);
  const state = () => sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: "webop:overlay_state" }), tab_id);
  await call(sw, "computer", { action: "screenshot", tab_id });
  const vp = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  // Any click moves the phantom cursor in; the coordinate is in screenshot space, which the context maps back.
  const hovered = await call(sw, "computer", { action: "hover", tab_id, coordinate: [Math.floor(vp.w / 4), Math.floor(vp.h / 4)] });
  assert.ok("content" in hovered, "error" in hovered ? hovered.error.message : "");
  assert.equal((await state()).cursorOpacity, "1");
  await sw.evaluate(() => (globalThis as any).__webop.closeSession("test"));
  const after = await state();
  assert.equal(after.cursorOpacity, "0");
  assert.equal(after.glowOpacity, "0");
});

const overlayHosts = (page: import("@playwright/test").Page) =>
  page.evaluate(() => [...document.documentElement.children].filter((e) => (e as HTMLElement).style.cssText.includes("2147483646")).length);

test("t_foreign_tab_untouched: user-opened tabs get no overlay host", async () => {
  const { sw, baseUrl, context } = await open();
  await openForeignTab(sw, `${baseUrl}/button.html`);
  const page = context.pages().find((p) => p.url() === `${baseUrl}/button.html`);
  assert.ok(page);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await overlayHosts(page), 0);
});

test("t_owned_tab_after_reload: read_page and ref click work, single overlay host", async () => {
  const { sw, baseUrl, context } = await open();
  const tab_id = await create(sw, `${baseUrl}/button.html`);
  const page = context.pages().find((p) => p.url() === `${baseUrl}/button.html`);
  assert.ok(page);
  assert.equal(await overlayHosts(page), 1);
  await page.reload();
  const tree = textOf(await call(sw, "read_page", { tab_id, filter: "interactive" }));
  const ref = /\[(ref_\d+)\]/.exec(tree)?.[1];
  assert.ok(ref, tree);
  await call(sw, "computer", { action: "screenshot", tab_id });
  const clicked = await call(sw, "computer", { action: "left_click", tab_id, ref });
  assert.ok("content" in clicked, "error" in clicked ? clicked.error.message : "");
  assert.equal(await overlayHosts(page), 1);
});
