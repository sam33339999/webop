import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import type { ScreenshotContext } from "@webop/core/coords";
import { call, launch, openTab, type Launched } from "./harness.ts";

const opened: Launched[] = [];
async function open() {
  const h = await launch();
  opened.push(h);
  return h;
}
after(async () => { for (const h of opened) await h.close(); });

function pageOf(h: Launched, base: string, path: string): Page {
  const page = h.context.pages().find((p) => p.url() === `${base}${path}`);
  assert.ok(page, `page ${path} open`);
  return page;
}

async function ctxOf(h: Launched, tab_id: number): Promise<ScreenshotContext> {
  const ctx = await h.sw.evaluate((id) => (globalThis as any).__webop.getContext(id), tab_id);
  assert.ok(ctx, "context stored");
  return ctx;
}

/** Center of a selector in screenshot-frame coordinates. */
async function centerOf(h: Launched, page: Page, tab_id: number, selector: string): Promise<[number, number]> {
  const ctx = await ctxOf(h, tab_id);
  const r = await page.evaluate((s) => {
    const b = document.querySelector(s)!.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }, selector);
  return [(r.x * ctx.screenshotWidth) / ctx.viewportWidth, (r.y * ctx.screenshotHeight) / ctx.viewportHeight];
}

test("left_click by coordinate is trusted", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/button.html`);
  const page = pageOf(h, h.baseUrl, "/button.html");
  await call(h.sw, "computer", { action: "screenshot", tab_id });
  const coordinate = await centerOf(h, page, tab_id, "#btn");
  const r = await call(h.sw, "computer", { action: "left_click", tab_id, coordinate });
  assert.ok("content" in r, "error" in r ? r.error.message : "");
  assert.equal(await page.title(), "clicked:true");
});

test("click result includes fresh screenshot", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/button.html`);
  const page = pageOf(h, h.baseUrl, "/button.html");
  await call(h.sw, "computer", { action: "screenshot", tab_id });
  const coordinate = await centerOf(h, page, tab_id, "#btn");
  const r = await call(h.sw, "computer", { action: "left_click", tab_id, coordinate });
  assert.ok("content" in r);
  assert.ok(r.content.some((b) => b.type === "image"));
});

test("oob coordinate rejected", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/button.html`);
  await call(h.sw, "computer", { action: "screenshot", tab_id });
  const ctx = await ctxOf(h, tab_id);
  const r = await call(h.sw, "computer", { action: "left_click", tab_id, coordinate: [ctx.screenshotWidth + 2, 0] });
  assert.ok("error" in r);
  assert.equal(r.error.code, "oob");
});

test("click before screenshot is invalid_args", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/button.html`);
  const r = await call(h.sw, "computer", { action: "left_click", tab_id, coordinate: [10, 10] });
  assert.ok("error" in r);
  assert.equal(r.error.code, "invalid_args");
  assert.match(r.error.message, /take a screenshot first/);
});

test("type and key", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/form.html`);
  const page = pageOf(h, h.baseUrl, "/form.html");
  await call(h.sw, "computer", { action: "screenshot", tab_id });
  const coordinate = await centerOf(h, page, tab_id, "#name");
  await call(h.sw, "computer", { action: "left_click", tab_id, coordinate });
  await call(h.sw, "computer", { action: "type", tab_id, text: "hello" });
  assert.equal(await page.inputValue("#name"), "hello");
  await call(h.sw, "computer", { action: "key", tab_id, text: "ctrl+a" });
  await call(h.sw, "computer", { action: "key", tab_id, text: "Backspace" });
  assert.equal(await page.inputValue("#name"), "");
});

test("scroll down 3 ticks", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/long.html`);
  const page = pageOf(h, h.baseUrl, "/long.html");
  await call(h.sw, "computer", { action: "screenshot", tab_id });
  const r = await call(h.sw, "computer", { action: "scroll", tab_id, coordinate: [100, 100], scroll_direction: "down", scroll_amount: 3 });
  assert.ok("content" in r, "error" in r ? r.error.message : "");
  await page.waitForFunction(() => window.scrollY === 300, undefined, { timeout: 3000 });
  assert.equal(await page.evaluate(() => window.scrollY), 300);
});

test("overlay hidden during capture", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/button.html`);
  await h.sw.evaluate(() => { (globalThis as any).__webop.hiderLog.length = 0; });
  await call(h.sw, "computer", { action: "screenshot", tab_id });
  const log: Array<{ hidden?: boolean; at?: string }> = await h.sw.evaluate(() => JSON.parse(JSON.stringify((globalThis as any).__webop.hiderLog)));
  assert.deepEqual(log.map((e) => e.hidden === undefined ? e.at : `hidden:${e.hidden}`), ["hidden:true", "before", "after", "hidden:false"]);
});
