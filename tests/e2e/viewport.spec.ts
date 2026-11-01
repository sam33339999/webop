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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fresh() {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/blocking.html`);
  const page = h.context.pages().find((p) => p.url().includes("/blocking.html")) as Page;
  assert.ok(page);
  return { h, tab_id, page };
}

async function screenshotCtx(h: Launched, tab_id: number) {
  const r = await call(h.sw, "computer", { action: "screenshot", tab_id });
  assert.ok("content" in r, "error" in r ? r.error.message : "");
  return h.sw.evaluate((id) => (globalThis as any).__webop.getContext(id), tab_id) as Promise<{ viewportWidth: number; viewportHeight: number; screenshotWidth: number; screenshotHeight: number }>;
}

async function incCenter(page: Page, ctx: { viewportWidth: number; viewportHeight: number; screenshotWidth: number; screenshotHeight: number }): Promise<[number, number]> {
  const r = await page.evaluate(() => {
    const b = document.querySelector("#inc")!.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
  return [(r.x * ctx.screenshotWidth) / ctx.viewportWidth, (r.y * ctx.screenshotHeight) / ctx.viewportHeight];
}

test("t_viewport_changed_refuses_click: a coordinate from before a resize is refused, a fresh one works", async () => {
  const { h, tab_id, page } = await fresh();
  const ctx = await screenshotCtx(h, tab_id);
  const stale = await incCenter(page, ctx);
  const resized = page.evaluate(() => new Promise<void>((r) => addEventListener("resize", () => r(), { once: true })));
  await h.sw.evaluate(async (id) => {
    const tab = await chrome.tabs.get(id);
    const win = await chrome.windows.get(tab.windowId);
    await chrome.windows.update(tab.windowId, { left: 0, top: 0, width: win.width as number, height: (win.height as number) - 60 });
  }, tab_id);
  await resized;
  await sleep(300);
  const r = await call(h.sw, "computer", { action: "left_click", tab_id, coordinate: stale });
  assert.ok("error" in r, "expected an error");
  assert.equal(r.error.code, "invalid_args");
  assert.match(r.error.message, /Not performed: the viewport changed/);
  assert.equal(await page.evaluate(() => document.title), "count:0");
  const ctx2 = await screenshotCtx(h, tab_id);
  const ok = await call(h.sw, "computer", { action: "left_click", tab_id, coordinate: await incCenter(page, ctx2) });
  assert.ok("content" in ok, "error" in ok ? ok.error.message : "");
  assert.equal(await page.evaluate(() => document.title), "count:1");
});

test("t_first_screenshot_after_attach_is_settled: the viewport does not change after the first screenshot returns", async () => {
  const { h, tab_id, page } = await fresh();
  const ctx = await screenshotCtx(h, tab_id);
  await sleep(1000);
  const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  assert.deepEqual(size, { w: ctx.viewportWidth, h: ctx.viewportHeight });
});
