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

/** Opens the blocking fixture, takes a screenshot context and returns the screenshot-frame centers of #btn (blocks) and #inc (counts). */
async function setup(ms: number, timeouts: { cdpSendMs: number; callDeadlineMs: number; probeMs?: number }) {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/blocking.html?ms=${ms}`);
  const page = h.context.pages().find((p) => p.url().includes("/blocking.html")) as Page;
  assert.ok(page);
  await call(h.sw, "computer", { action: "screenshot", tab_id });
  const ctx = await h.sw.evaluate((id) => (globalThis as any).__webop.getContext(id), tab_id);
  const centerOf = async (selector: string): Promise<[number, number]> => {
    const r = await page.evaluate((sel) => {
      const b = document.querySelector(sel)!.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }, selector);
    return [(r.x * ctx.screenshotWidth) / ctx.viewportWidth, (r.y * ctx.screenshotHeight) / ctx.viewportHeight];
  };
  const coordinate = await centerOf("#btn");
  const incCoordinate = await centerOf("#inc");
  await h.sw.evaluate((t) => (globalThis as any).__webop.setTimeouts(t), timeouts);
  return { h, tab_id, page, coordinate, incCoordinate };
}

const ACTION_PREFIX = /^The action may have been partially or fully performed: /;

test("t_send_timeout: a click that blocks the page returns timeout, not a 60 s hang", async () => {
  const { h, tab_id, coordinate } = await setup(6000, { cdpSendMs: 1000, callDeadlineMs: 50_000 });
  const t0 = Date.now();
  const e = errOf(await call(h.sw, "computer", { action: "left_click", tab_id, coordinate }));
  const took = Date.now() - t0;
  assert.equal(e.code, "timeout");
  assert.match(e.message, ACTION_PREFIX, "input had already been sent");
  assert.match(e.message, /did not complete within 1s/);
  assert.ok(took < 4000, `took ${took}ms`);
});

test("t_close_while_blocked: tabs_close succeeds while a call is in flight; in-flight and queued calls fail with tab_not_in_session", async () => {
  const { h, tab_id, coordinate } = await setup(30_000, { cdpSendMs: 20_000, callDeadlineMs: 50_000 });
  const click = call(h.sw, "computer", { action: "left_click", tab_id, coordinate });
  await sleep(1000);
  const queued = call(h.sw, "computer", { action: "screenshot", tab_id });
  await sleep(200);
  const t0 = Date.now();
  const closed = await call(h.sw, "tabs_close", { tab_id });
  assert.ok("content" in closed, "error" in closed ? closed.error.message : "");
  assert.ok(Date.now() - t0 < 3000, "close was prompt");
  assert.equal(errOf(await click).code, "tab_not_in_session");
  assert.equal(errOf(await queued).code, "tab_not_in_session");
});

test("positive control: the counter click changes state when the page is not blocked", async () => {
  const { h, tab_id, page, incCoordinate } = await setup(6000, { cdpSendMs: 2000, callDeadlineMs: 1000 });
  const r = await call(h.sw, "computer", { action: "left_click", tab_id, coordinate: incCoordinate });
  assert.ok("content" in r, "error" in r ? r.error.message : "");
  assert.equal(await page.evaluate(() => document.title), "count:1");
});

test("t_queued_dropped: an action queued behind a blocked call is not performed (deadline passed at the front of the queue)", async () => {
  // Send timeout (2 s) > call deadline (1 s): the queued call reaches the front already past its deadline.
  const { h, tab_id, page, coordinate, incCoordinate } = await setup(6000, { cdpSendMs: 2000, callDeadlineMs: 1000 });
  const blocked = call(h.sw, "computer", { action: "left_click", tab_id, coordinate });
  await sleep(500);
  const queued = call(h.sw, "computer", { action: "left_click", tab_id, coordinate: incCoordinate });
  assert.equal(errOf(await blocked).code, "timeout");
  const second = errOf(await queued);
  assert.equal(second.code, "timeout");
  assert.match(second.message, /Not performed/);
  assert.equal(await page.evaluate(() => document.title), "count:0", "the queued click never landed");
});

test("t_queued_probe: with prod-like ordering (send < deadline) the liveness probe refuses a queued action", async () => {
  const { h, tab_id, page, coordinate, incCoordinate } = await setup(6000, { cdpSendMs: 1000, callDeadlineMs: 4000, probeMs: 300 });
  const blocked = call(h.sw, "computer", { action: "left_click", tab_id, coordinate });
  await sleep(300);
  const queued = call(h.sw, "computer", { action: "left_click", tab_id, coordinate: incCoordinate });
  assert.equal(errOf(await blocked).code, "timeout");
  const second = errOf(await queued);
  assert.equal(second.code, "timeout");
  assert.match(second.message, /^Not performed: the page is not responding/);
  assert.equal(await page.evaluate(() => document.title), "count:0", "the queued click never landed");
});

test("t_real_alert: a real alert() blocks the page; the next action is refused and nothing lands after dismissal", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/alert.html`);
  const page = h.context.pages().find((p) => p.url().includes("/alert.html")) as Page;
  assert.ok(page);
  // A registered listener that never accepts/dismisses stops Playwright from auto-closing the dialog.
  const dialogs: Array<{ dismiss(): Promise<void> }> = [];
  page.on("dialog", (d) => { dialogs.push(d); });
  await call(h.sw, "computer", { action: "screenshot", tab_id });
  const ctx = await h.sw.evaluate((id) => (globalThis as any).__webop.getContext(id), tab_id);
  const centerOf = async (selector: string): Promise<[number, number]> => {
    const r = await page.evaluate((sel) => {
      const b = document.querySelector(sel)!.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }, selector);
    return [(r.x * ctx.screenshotWidth) / ctx.viewportWidth, (r.y * ctx.screenshotHeight) / ctx.viewportHeight];
  };
  const alertAt = await centerOf("#alert");
  const incAt = await centerOf("#inc");
  await h.sw.evaluate((t) => (globalThis as any).__webop.setTimeouts(t), { cdpSendMs: 1000, callDeadlineMs: 50_000, probeMs: 500 });

  assert.equal(errOf(await call(h.sw, "computer", { action: "left_click", tab_id, coordinate: alertAt })).code, "timeout");
  assert.equal(dialogs.length, 1, "the alert dialog is really open");
  const second = errOf(await call(h.sw, "computer", { action: "left_click", tab_id, coordinate: incAt }));
  assert.equal(second.code, "timeout");
  assert.match(second.message, /^Not performed/);

  await dialogs[0].dismiss();
  await sleep(500);
  assert.notEqual(await page.evaluate(() => document.title), "count 1", "the refused click never landed");
});
