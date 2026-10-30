import { test, after } from "node:test";
import assert from "node:assert/strict";
import { call, launch, openForeignTab, type Launched } from "./harness.ts";
import type { Worker } from "@playwright/test";

const opened: Launched[] = [];
async function open() {
  const h = await launch();
  opened.push(h);
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
  assert.match(e.message, /add it in webop options/);
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
