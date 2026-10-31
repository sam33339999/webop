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

/** Opens the blocking fixture and clicks its button (center of the viewport-sized flex layout is near #btn). */
async function setup(ms: number, timeouts: { cdpSendMs: number; callDeadlineMs: number }) {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/blocking.html?ms=${ms}`);
  const page = h.context.pages().find((p) => p.url().includes("/blocking.html")) as Page;
  assert.ok(page);
  await call(h.sw, "computer", { action: "screenshot", tab_id });
  const ctx = await h.sw.evaluate((id) => (globalThis as any).__webop.getContext(id), tab_id);
  const r = await page.evaluate(() => {
    const b = document.querySelector("#btn")!.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
  const coordinate: [number, number] = [(r.x * ctx.screenshotWidth) / ctx.viewportWidth, (r.y * ctx.screenshotHeight) / ctx.viewportHeight];
  await h.sw.evaluate((t) => (globalThis as any).__webop.setTimeouts(t), timeouts);
  return { h, tab_id, page, coordinate };
}

test("t_send_timeout: a click that blocks the page returns timeout, not a 60 s hang", async () => {
  const { h, tab_id, coordinate } = await setup(6000, { cdpSendMs: 1000, callDeadlineMs: 50_000 });
  const t0 = Date.now();
  const e = errOf(await call(h.sw, "computer", { action: "left_click", tab_id, coordinate }));
  const took = Date.now() - t0;
  assert.equal(e.code, "timeout");
  assert.match(e.message, /did not complete within 1s/);
  assert.ok(took < 4000, `took ${took}ms`);
});

test("t_close_while_blocked: tabs_close succeeds while a call is in flight on a blocked tab", async () => {
  const { h, tab_id, coordinate } = await setup(30_000, { cdpSendMs: 20_000, callDeadlineMs: 50_000 });
  const click = call(h.sw, "computer", { action: "left_click", tab_id, coordinate });
  await sleep(1000);
  const t0 = Date.now();
  const closed = await call(h.sw, "tabs_close", { tab_id });
  assert.ok("content" in closed, "error" in closed ? closed.error.message : "");
  assert.ok(Date.now() - t0 < 3000, "close was prompt");
  // The in-flight call must not hang once its tab is gone.
  const r = await click;
  assert.ok("error" in r);
});

test("t_queued_dropped: an action queued behind a blocked call is not performed after the page unblocks", async () => {
  // Send timeout (2 s) > call deadline (1 s): the queued call reaches the front already past its deadline.
  const { h, tab_id, page, coordinate } = await setup(6000, { cdpSendMs: 2000, callDeadlineMs: 1000 });
  const blocked = call(h.sw, "computer", { action: "left_click", tab_id, coordinate });
  await sleep(500);
  const queued = call(h.sw, "computer", { action: "type", tab_id, text: "late" });
  const first = errOf(await blocked);
  assert.equal(first.code, "timeout");
  const second = errOf(await queued);
  assert.equal(second.code, "timeout");
  assert.match(second.message, /Not performed/);
  // Wait for the page to unblock, then prove the typing never landed.
  assert.equal(await page.inputValue("#field", { timeout: 15_000 }), "");
});
