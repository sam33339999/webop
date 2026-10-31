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

async function framed(h: Launched, src: string, frameUrlPrefix: string) {
  const tab_id = await openTab(h.sw, `${h.baseUrl}/frame.html?src=${encodeURIComponent(src)}`);
  const page = h.context.pages().find((p) => p.url().startsWith(`${h.baseUrl}/frame.html`));
  assert.ok(page);
  let frame = page.frames().find((f) => f.url().startsWith(frameUrlPrefix));
  for (let i = 0; i < 50 && !frame; i++) {
    await new Promise((r) => setTimeout(r, 100));
    frame = page.frames().find((f) => f.url().startsWith(frameUrlPrefix));
  }
  assert.ok(frame, "frame loaded");
  await frame.waitForLoadState("load");
  await call(h.sw, "computer", { action: "screenshot", tab_id });
  return { tab_id, page, frame };
}

test("click inside a cross-site iframe is denied and nothing reaches the frame", async () => {
  const h = await open();
  const { tab_id, page, frame } = await framed(h, `${h.altUrl}/button.html`, h.altUrl);
  const coordinate = await centerOf(h, page, tab_id, "#f");
  for (const action of ["left_click", "right_click", "double_click", "hover"] as const) {
    const r = await call(h.sw, "computer", { action, tab_id, coordinate });
    assert.ok("error" in r, action);
    assert.equal(r.error.code, "permission_denied", action);
    assert.match(r.error.message, /cross-site frame \(127\.0\.0\.1\)/);
  }
  const drag = await call(h.sw, "computer", { action: "left_click_drag", tab_id, start_coordinate: coordinate, coordinate: [coordinate[0] + 5, coordinate[1]] });
  assert.ok("error" in drag && drag.error.code === "permission_denied");
  assert.equal(await frame.evaluate(() => document.title), "button");
});

test("type and key while a cross-site iframe has focus are denied", async () => {
  const h = await open();
  const { tab_id, page, frame } = await framed(h, `${h.altUrl}/form.html`, h.altUrl);
  await frame.focus("#name");
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "IFRAME");
  for (const args of [{ action: "type", text: "stolen" }, { action: "key", text: "a" }]) {
    const r = await call(h.sw, "computer", { ...args, tab_id });
    assert.ok("error" in r, args.action);
    assert.equal(r.error.code, "permission_denied", args.action);
  }
  assert.equal(await frame.inputValue("#name"), "");
});

test("same-site iframe is allowed", async () => {
  const h = await open();
  const { tab_id, page, frame } = await framed(h, `${h.baseUrl}/button.html`, `${h.baseUrl}/button.html`);
  const coordinate = await centerOf(h, page, tab_id, "#f");
  const r = await call(h.sw, "computer", { action: "left_click", tab_id, coordinate });
  assert.ok("content" in r, "error" in r ? r.error.message : "");
  assert.equal(await frame.evaluate(() => document.title), "clicked:true");
});

test("t_action_ok_screenshot_fails: a failed capture after a delivered click is not reported as an error", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/button.html`);
  const page = pageOf(h, h.baseUrl, "/button.html");
  await call(h.sw, "computer", { action: "screenshot", tab_id });
  const coordinate = await centerOf(h, page, tab_id, "#btn");
  await h.sw.evaluate(() => (globalThis as any).__webop.failNextCapture());
  const r = await call(h.sw, "computer", { action: "left_click", tab_id, coordinate });
  assert.ok("content" in r, "error" in r ? r.error.message : "");
  assert.equal(r.content.length, 1);
  const t = r.content[0];
  assert.ok(t.type === "text");
  assert.match(t.text, /^Action performed; screenshot failed: /);
  assert.equal(await page.title(), "clicked:true");
});

test("t_action_ok_session_closed_during_capture: a delivered click whose session ended is an error, not success", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/button.html`);
  const page = pageOf(h, h.baseUrl, "/button.html");
  await call(h.sw, "computer", { action: "screenshot", tab_id });
  const coordinate = await centerOf(h, page, tab_id, "#btn");
  await h.sw.evaluate(() => (globalThis as any).__webop.failNextCapture({ closeSession: "test" }));
  const r = await call(h.sw, "computer", { action: "left_click", tab_id, coordinate });
  assert.ok("error" in r, "must not be reported as success");
  assert.equal(r.error.code, "tab_not_in_session");
  assert.match(r.error.message, /^The action may have been partially or fully performed: /);
});

test("t_afterload_zero_limit: limitMs <= 0 times out without calling start()", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/button.html`);
  const r = await h.sw.evaluate(async (id) => {
    let started = false;
    try {
      await (globalThis as any).__webop.afterLoad(id, async () => { started = true; }, 0);
      return { started, error: null };
    } catch (e: any) {
      return { started, error: { code: e.code, message: e.message } };
    }
  }, tab_id);
  assert.equal(r.started, false);
  assert.equal(r.error?.code, "timeout");
  assert.match(r.error?.message ?? "", /^Not performed:/);
});
