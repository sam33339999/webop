import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import { call, launch, openTab, type Launched } from "./harness.ts";

const opened: Launched[] = [];
async function open() {
  const h = await launch();
  opened.push(h);
  return h;
}
after(async () => { for (const h of opened) await h.close(); });

type R = Awaited<ReturnType<typeof call>>;
function errOf(r: R) {
  assert.ok("error" in r, "expected an error");
  return r.error;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hook = <T>(h: Launched, fn: string, ...args: unknown[]): Promise<T> =>
  h.sw.evaluate(([f, a]) => (globalThis as any).__webop[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
const pageOf = (h: Launched, part: string): Page => h.context.pages().find((p) => p.url().includes(part)) as Page;

/** Center of the stop button: fixed 88x36 box, 16 px from the right and bottom edges of the viewport. */
async function stopPoint(page: Page): Promise<[number, number]> {
  const v = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  return [v.w - 16 - 44, v.h - 16 - 18];
}
async function waitFor(fn: () => Promise<boolean> | boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("t_stop_inflight: stop while the page is blocked in a CDP send fails the running and the queued calls promptly", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/blocking.html?ms=5000`);
  const page = pageOf(h, "/blocking.html");
  await call(h.sw, "computer", { action: "screenshot", tab_id });
  const ctx = await hook<any>(h, "getContext", tab_id);
  const centerOf = async (sel: string): Promise<[number, number]> => {
    const r = await page.evaluate((s) => {
      const b = document.querySelector(s)!.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }, sel);
    return [(r.x * ctx.screenshotWidth) / ctx.viewportWidth, (r.y * ctx.screenshotHeight) / ctx.viewportHeight];
  };
  const coordinate = await centerOf("#btn");
  const incCoordinate = await centerOf("#inc");

  const running = call(h.sw, "computer", { action: "left_click", tab_id, coordinate });
  await sleep(800);
  const queuedShot = call(h.sw, "computer", { action: "screenshot", tab_id });
  const queuedClick = call(h.sw, "computer", { action: "left_click", tab_id, coordinate: incCoordinate });
  await sleep(200);
  const t0 = Date.now();
  await hook(h, "stopSession", "test");
  const e1 = errOf(await running);
  assert.ok(Date.now() - t0 < 2500, "the stop does not wait for the busy page");
  assert.equal(e1.code, "stopped_by_user");
  assert.match(e1.message, /^The action may have been partially or fully performed: /, "the click had already gone out");
  const e2 = errOf(await queuedShot);
  assert.equal(e2.code, "stopped_by_user");
  assert.equal(e2.message, "Not performed: the user pressed stop.");
  assert.equal(errOf(await queuedClick).code, "stopped_by_user");
  await sleep(5000);
  assert.equal(await page.evaluate(() => document.title), "count:0", "the queued click never happened");
});

test("t_stop_halts_input_sequence: a multi-event action stops between events", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/form.html`);
  const page = pageOf(h, "/form.html");
  await call(h.sw, "computer", { action: "screenshot", tab_id });
  const running = call(h.sw, "computer", { action: "key", tab_id, text: Array(6000).fill("a").join(" ") });
  await sleep(100);
  await hook(h, "stopSession", "test");
  const e = errOf(await running);
  assert.equal(e.code, "stopped_by_user");
  const len = await page.evaluate(() => (document.getElementById("name") as HTMLInputElement).value.length);
  assert.ok(len > 0 && len < 6000, `partial input, got ${len}`);
  await sleep(500);
  assert.equal(await page.evaluate(() => (document.getElementById("name") as HTMLInputElement).value.length), len, "nothing arrives after the stop");
});

test("t_stop_creates_no_tab: a stop that lands while tabs_create waits for the session lock opens nothing", async () => {
  const h = await open();
  await h.sw.evaluate(() => {
    const w = globalThis as any;
    w.__webop.sessionDevHooks.beforeCreate = () => new Promise<void>((r) => { w.__release = r; });
  });
  const before = (await h.sw.evaluate(() => chrome.tabs.query({}))).length;
  const created = call(h.sw, "tabs_create", { url: `${h.baseUrl}/button.html` });
  await waitFor(() => h.sw.evaluate(() => typeof (globalThis as any).__release === "function"), "createTab inside the lock");
  await hook(h, "stopSession", "test");
  await h.sw.evaluate(() => (globalThis as any).__release());
  assert.equal(errOf(await created).code, "stopped_by_user");
  assert.equal((await h.sw.evaluate(() => chrome.tabs.query({}))).length, before, "no tab was opened");
});

test("t_stop_other_session_unaffected: stopping one session leaves another session's tab and grants alone", async () => {
  const h = await open();
  const tabA = await openTab(h.sw, `${h.baseUrl}/button.html`, "a");
  const tabB = await openTab(h.sw, `${h.baseUrl}/button.html`, "b");
  await hook(h, "grant", "b", "127.0.0.1", "act", "once");
  await call(h.sw, "computer", { action: "screenshot", tab_id: tabA }, "a");
  await hook(h, "stopSession", "a");
  assert.equal(await hook<number>(h, "stopEpoch", "a"), 1);
  assert.equal(await hook<number>(h, "stopEpoch", "b"), 0);
  const shot = await call(h.sw, "computer", { action: "screenshot", tab_id: tabB }, "b");
  assert.ok("content" in shot, "error" in shot ? shot.error.message : "");
  const once = await h.sw.evaluate(() => chrome.storage.session.get("webop.session_grants").then((r) => (r["webop.session_grants"] ?? {}) as Record<string, unknown>));
  assert.deepEqual(once.b, { "127.0.0.1": ["act"] });
});

test("t_toolbar_icon_stops_all: the toolbar icon handler stops every session of the profile", async () => {
  const h = await open();
  const tabA = await openTab(h.sw, `${h.baseUrl}/button.html`, "a");
  const tabB = await openTab(h.sw, `${h.baseUrl}/button.html`, "b");
  await call(h.sw, "computer", { action: "screenshot", tab_id: tabA }, "a");
  await call(h.sw, "computer", { action: "screenshot", tab_id: tabB }, "b");
  await hook(h, "grant", "a", "127.0.0.1", "act", "once");
  await hook(h, "actionClicked");
  await waitFor(async () => (await hook<number>(h, "stopEpoch", "a")) === 1 && (await hook<number>(h, "stopEpoch", "b")) === 1, "both sessions stopped");
  const once = await h.sw.evaluate(() => chrome.storage.session.get("webop.session_grants").then((r) => (r["webop.session_grants"] ?? {}) as Record<string, unknown>));
  assert.equal(once.a, undefined);
});

test("t_cancel_inflight_no_double_report: a call that already reported the cancel does not leave a notice for the next call", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/form.html`);
  await call(h.sw, "computer", { action: "screenshot", tab_id });
  const running = call(h.sw, "computer", { action: "key", tab_id, text: Array(6000).fill("a").join(" ") });
  await sleep(250);
  await h.sw.evaluate((id) => (globalThis as any).__webop.simulateDetach(id, "canceled_by_user"), tab_id);
  const e = errOf(await running);
  assert.ok(e.code === "stopped_by_user" || e.code === "detached_by_user", e.code);
  await sleep(300);
  const next = await call(h.sw, "computer", { action: "screenshot", tab_id });
  assert.ok("content" in next, "error" in next ? next.error.message : "");
});

test("t_glow_tracks_operating: glow and stop button show for navigate and read_page, survive a reload, vanish on stop and return on the next call", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/button.html`);
  const page = pageOf(h, "/button.html");
  const state = () => h.sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: "webop:overlay_state" }), tab_id);
  const glowIs = (v: string) => waitFor(async () => (await state().catch(() => ({}))).glowOpacity === v && (v === "0" || (await state()).stopDisplay === "block"), `glow ${v}`);
  assert.ok("content" in await call(h.sw, "navigate", { tab_id, url: `${h.baseUrl}/button.html` }));
  await glowIs("1");
  await page.reload();
  await glowIs("1");
  await hook(h, "stopSession", "test");
  await waitFor(async () => (await state()).glowOpacity === "0" && (await state()).stopDisplay === "none", "glow off after stop");
  assert.ok("content" in await call(h.sw, "read_page", { tab_id }));
  await glowIs("1");
});

test("t_stop_button_survives_page_css: page CSS and a max z-index element cannot hide or cover the stop button", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/button.html`);
  const page = pageOf(h, "/button.html");
  await call(h.sw, "computer", { action: "screenshot", tab_id });
  assert.ok("content" in await call(h.sw, "computer", { action: "hover", tab_id, coordinate: [40, 40] }));
  await page.evaluate(() => {
    const st = document.createElement("style");
    st.textContent = "html > div { display: none !important; visibility: hidden !important; } html > div:not(#x) { opacity: 0 !important; }";
    document.head.append(st);
    const d = document.createElement("div");
    d.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.1)";
    document.body.append(d);
  });
  const [sx, sy] = await stopPoint(page);
  await page.mouse.click(sx, sy);
  await waitFor(async () => (await hook<number>(h, "stopEpoch", "test")) === 1, "stop despite hostile page CSS");
});

test("t_stop_revokes_once_grants: stop drops once-grants (the next action asks again) and leaves permanent grants alone", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.altUrl}/button.html`, "s1");
  const page = pageOf(h, "/button.html");
  await hook(h, "grant", "s1", "127.0.0.1", "act", "once");
  const shot = await call(h.sw, "computer", { action: "screenshot", tab_id }, "s1");
  assert.ok("content" in shot, "error" in shot ? shot.error.message : "");
  const hovered = await call(h.sw, "computer", { action: "hover", tab_id, coordinate: [40, 40] }, "s1");
  assert.ok("content" in hovered, "error" in hovered ? hovered.error.message : "");
  const onceOf = () => h.sw.evaluate(() => chrome.storage.session.get("webop.session_grants").then((r) => ((r["webop.session_grants"] ?? {}) as Record<string, unknown>).s1));
  assert.deepEqual(await onceOf(), { "127.0.0.1": ["act"] });

  const [sx, sy] = await stopPoint(page);
  await page.mouse.click(sx, sy);
  await waitFor(async () => (await hook<number>(h, "stopEpoch", "s1")) === 1, "stop epoch");
  await waitFor(async () => (await onceOf()) === undefined, "once grants revoked");
  const always = await h.sw.evaluate(() => chrome.storage.local.get("webop.grants").then((r) => r["webop.grants"] as Record<string, string[]>));
  assert.deepEqual(always.localhost, ["act"], "permanent grants are untouched");

  // The session is still open: the next action goes through the prompt again.
  const next = call(h.sw, "computer", { action: "hover", tab_id, coordinate: [40, 40] }, "s1");
  await waitFor(() => h.context.pages().some((p) => p.url().includes("prompt.html")), "permission prompt");
  await h.context.pages().find((p) => p.url().includes("prompt.html"))!.getByRole("button", { name: "拒絕" }).click();
  assert.equal(errOf(await next).code, "permission_denied");
});

test("t_stop_page_script_cannot_reach_button: the closed shadow root keeps page script from clicking the stop button", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/button.html`);
  const page = pageOf(h, "/button.html");
  await call(h.sw, "computer", { action: "screenshot", tab_id });
  const hovered = await call(h.sw, "computer", { action: "hover", tab_id, coordinate: [40, 40] });
  assert.ok("content" in hovered, "error" in hovered ? hovered.error.message : "");
  const [sx, sy] = await stopPoint(page);
  await page.evaluate(([x, y]) => {
    const host = [...document.documentElement.children].find((e) => (e as HTMLElement).style.cssText.includes("2147483647")) as HTMLElement;
    const fire = (t: EventTarget) => t.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, clientX: x, clientY: y }));
    fire(host);
    fire(document.documentElement);
    document.elementFromPoint(x, y)?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
  }, [sx, sy] as const);
  await sleep(500);
  assert.equal(await hook<number>(h, "stopEpoch", "test"), 0);
  // Control: a real click on the same spot does stop.
  await page.mouse.click(sx, sy);
  await waitFor(async () => (await hook<number>(h, "stopEpoch", "test")) === 1, "trusted click to stop");
});

test("t_cancel_then_next_call_detached_once: the debugger-bar cancel stops the session; the next call on that tab says so once", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/button.html`);
  const first = await call(h.sw, "computer", { action: "screenshot", tab_id });
  assert.ok("content" in first, "error" in first ? first.error.message : "");
  await h.sw.evaluate((id) => (globalThis as any).__webop.simulateDetach(id, "canceled_by_user"), tab_id);
  assert.equal(await hook<number>(h, "stopEpoch", "test"), 1, "treated as stop for the owning session");
  const e = errOf(await call(h.sw, "computer", { action: "screenshot", tab_id }));
  assert.equal(e.code, "detached_by_user");
  assert.equal(e.message, "Not performed: the user stopped debugging this tab; retry to re-attach.");
  const again = await call(h.sw, "computer", { action: "screenshot", tab_id });
  assert.ok("content" in again, "error" in again ? again.error.message : "");
});

test("t_badge_count: the action badge shows how many host sessions are open", async () => {
  const h = await open();
  const badge = () => h.sw.evaluate(() => chrome.action.getBadgeText({}));
  assert.equal(await badge(), "");
  await hook(h, "openSession", "a", "client-a");
  await hook(h, "openSession", "b", "client-b");
  assert.equal(await badge(), "2");
  await hook(h, "closeSession", "a");
  assert.equal(await badge(), "1");
  await hook(h, "closeSession", "b");
  assert.equal(await badge(), "");
});

test("t_agent_click_under_stop_button: the agent's own click at the stop button's position hits the page, not the stop button", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/corner.html`);
  const page = pageOf(h, "/corner.html");
  const shot = await call(h.sw, "computer", { action: "screenshot", tab_id });
  assert.ok("content" in shot, "error" in shot ? shot.error.message : "");
  const state = () => h.sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: "webop:overlay_state" }), tab_id);
  await waitFor(async () => (await state()).stopDisplay === "block", "stop button shown");
  const ctx = await hook<any>(h, "getContext", tab_id);
  const [cx, cy] = await stopPoint(page);
  const coordinate = [(cx * ctx.screenshotWidth) / ctx.viewportWidth, (cy * ctx.screenshotHeight) / ctx.viewportHeight];
  const r = await call(h.sw, "computer", { action: "left_click", tab_id, coordinate });
  assert.ok("content" in r, "error" in r ? r.error.message : "");
  assert.equal(await page.evaluate(() => document.title), "corner:1", "the page button received the click");
  assert.equal(await hook<number>(h, "stopEpoch", "test"), 0, "the session was not stopped");
  await waitFor(async () => { const s = await state(); return s.stopDisplay === "block" && s.hidden === false; }, "stop button visible again");
});

test("t_late_glow_after_stop: a glow-on still waiting for its ownership check does not re-show after a stop", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/button.html`);
  const state = () => h.sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: "webop:overlay_state" }), tab_id);
  await h.sw.evaluate(() => {
    const w = globalThis as any;
    w.__webop.sessionDevHooks.beforeOwnCheck = () => new Promise<void>((r) => { w.__ownRelease = r; w.__webop.sessionDevHooks.beforeOwnCheck = undefined; });
  });
  const reading = call(h.sw, "read_page", { tab_id });
  await waitFor(() => h.sw.evaluate(() => typeof (globalThis as any).__ownRelease === "function"), "glow waiting on the ownership check");
  await hook(h, "stopSession", "test");
  await h.sw.evaluate(() => (globalThis as any).__ownRelease());
  await reading.catch(() => {});
  await sleep(600);
  const s = await state();
  assert.equal(s.glowOpacity, "0");
  assert.equal(s.stopDisplay, "none");
});

test("t_no_ask_after_stop: a call stopped while resolving the client name starts no permission prompt", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.altUrl}/button.html`);
  await h.sw.evaluate(() => {
    const w = globalThis as any;
    w.__webop.sessionDevHooks.beforeClientName = () => new Promise<void>((r) => { w.__nameRelease = r; w.__webop.sessionDevHooks.beforeClientName = undefined; });
  });
  const reading = call(h.sw, "read_page", { tab_id });
  await waitFor(() => h.sw.evaluate(() => typeof (globalThis as any).__nameRelease === "function"), "call waiting on the client name");
  await hook(h, "stopSession", "test");
  await h.sw.evaluate(() => (globalThis as any).__nameRelease());
  assert.equal(errOf(await reading).code, "stopped_by_user");
  await sleep(800);
  assert.equal(h.context.pages().filter((p) => p.url().includes("prompt.html")).length, 0, "no prompt window");
});

/** Installs a one-shot SW listener that presses stop as soon as the tab starts loading (i.e. while the call waits for the load). */
async function stopWhenLoading(h: Launched, onlyTabId?: number): Promise<void> {
  await h.sw.evaluate((only) => {
    const on = (id: number, info: { status?: string }) => {
      if (only !== undefined && id !== only) return;
      if (info.status !== "loading") return;
      chrome.tabs.onUpdated.removeListener(on);
      void (globalThis as any).__webop.stopSession("test");
    };
    chrome.tabs.onUpdated.addListener(on);
  }, onlyTabId);
}

test("t_stop_during_navigate_load: a stop during the load wait of a started navigation is not 'Not performed'", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/button.html`);
  const to = encodeURIComponent(`${h.altUrl}/button.html`);
  await stopWhenLoading(h, tab_id);
  const e = errOf(await call(h.sw, "navigate", { tab_id, url: `${h.baseUrl}/redirect.html?to=${to}` }));
  assert.equal(e.code, "stopped_by_user");
  assert.ok(!e.message.startsWith("Not performed"), e.message);
  assert.match(e.message, /^The navigation was started and may still complete: the user pressed stop\./);
});

test("t_stop_during_tabs_create_load: a stop after the tab was created says so and closes the tab", async () => {
  const h = await open();
  const before = (await h.sw.evaluate(() => chrome.tabs.query({}))).length;
  await stopWhenLoading(h);
  const e = errOf(await call(h.sw, "tabs_create", { url: `${h.baseUrl}/button.html` }));
  assert.equal(e.code, "stopped_by_user");
  assert.ok(!e.message.startsWith("Not performed"), e.message);
  assert.match(e.message, /tab was opened/);
  await waitFor(async () => (await h.sw.evaluate(() => chrome.tabs.query({}))).length === before, "tab closed");
});

test("t_input_keeps_glow_hides_only_stop_button: during an input action the host stays displayed, only the stop button is hidden", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/corner.html`);
  const page = pageOf(h, "/corner.html");
  assert.ok("content" in await call(h.sw, "computer", { action: "screenshot", tab_id }));
  const ctx = await hook<any>(h, "getContext", tab_id);
  const state = () => h.sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: "webop:overlay_state" }), tab_id);
  await waitFor(async () => (await state()).stopDisplay === "block", "stop button shown");
  await h.sw.evaluate(() => {
    const w = globalThis as any;
    w.__during = undefined;
    w.__webop.devHooks.afterTarget = async (id: number) => {
      w.__webop.devHooks.afterTarget = undefined;
      w.__during = await chrome.tabs.sendMessage(id, { type: "webop:overlay_state" });
    };
  });
  const [cx, cy] = await stopPoint(page);
  const r = await call(h.sw, "computer", { action: "left_click", tab_id, coordinate: [(cx * ctx.screenshotWidth) / ctx.viewportWidth, (cy * ctx.screenshotHeight) / ctx.viewportHeight] });
  assert.ok("content" in r, "error" in r ? r.error.message : "");
  const during = await h.sw.evaluate(() => (globalThis as any).__during);
  assert.equal(during.hidden, false, "glow/cursor host stays displayed");
  assert.equal(during.glowOpacity, "1");
  assert.equal(during.stopHidden, true, "the stop button is out of the way");
  assert.equal(await page.evaluate(() => document.title), "corner:1");
  await waitFor(async () => (await state()).stopHidden === false, "stop button back");
});
