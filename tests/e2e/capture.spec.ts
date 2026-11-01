import { test, after } from "node:test";
import assert from "node:assert/strict";
import { extensionIdFromKey } from "@webop/core/extension-id";
import type { ScreenshotContext } from "@webop/core/coords";
import { call, jpegSize, launch, openTab, type Launched } from "./harness.ts";
import manifest from "../../apps/extension/manifest.json" with { type: "json" };

const opened: Launched[] = [];
async function open(opts?: Parameters<typeof launch>[0]) {
  const h = await launch(opts);
  opened.push(h);
  return h;
}
after(async () => { for (const h of opened) await h.close(); });

function imageOf(r: Awaited<ReturnType<typeof call>>) {
  assert.ok("content" in r, "error" in r ? `${r.error.code}: ${r.error.message}` : "no content");
  const img = r.content.find((b) => b.type === "image");
  assert.ok(img && img.type === "image");
  return img;
}

test("extension id equals the id derived from manifest key", async () => {
  const { sw } = await open();
  assert.equal(new URL(sw.url()).host, await extensionIdFromKey(manifest.key));
});

test("screenshot returns jpeg within budget and stores context", async () => {
  const { sw, baseUrl } = await open();
  const tab_id = await openTab(sw, `${baseUrl}/button.html`);
  const img = imageOf(await call(sw, "computer", { action: "screenshot", tab_id }));
  assert.equal(img.mimeType, "image/jpeg");
  const { width, height } = jpegSize(Buffer.from(img.data, "base64"));
  assert.ok(Math.ceil(width / 28) * Math.ceil(height / 28) <= 1568);
  assert.ok(Math.max(width, height) <= 1568);
});

test("screenshot is preceded by a frame-size hint matching the image", async () => {
  const { sw, baseUrl } = await open();
  const tab_id = await openTab(sw, `${baseUrl}/button.html`);
  const r = await call(sw, "computer", { action: "screenshot", tab_id });
  assert.ok("content" in r, "error" in r ? r.error.message : "");
  const [hint, image] = r.content;
  assert.ok(hint.type === "text");
  assert.match(hint.text, /^Screenshot \d+x\d+ px/);
  assert.equal(image.type, "image");
  assert.ok(image.type === "image");
  const { width, height } = jpegSize(Buffer.from(image.data, "base64"));
  assert.equal(hint.text, `Screenshot ${width}x${height} px; use this frame for coordinates.`);
});

for (const dpr of [1, 2]) {
  test(`image size equals stored context at dpr ${dpr}`, async () => {
    const { sw, baseUrl, context } = await open({ deviceScaleFactor: dpr });
    const tab_id = await openTab(sw, `${baseUrl}/button.html`);
    const page = context.pages().find((p) => p.url().startsWith(baseUrl));
    assert.equal(await page?.evaluate(() => devicePixelRatio), dpr);
    const img = imageOf(await call(sw, "computer", { action: "screenshot", tab_id }));
    const { width, height } = jpegSize(Buffer.from(img.data, "base64"));
    const ctx: ScreenshotContext | undefined = await sw.evaluate((id) => (globalThis as any).__webop.getContext(id), tab_id);
    assert.ok(ctx, "context stored");
    assert.equal(width, ctx.screenshotWidth);
    assert.equal(height, ctx.screenshotHeight);
    assert.ok(ctx.viewportWidth > 0 && ctx.viewportHeight > 0);
  });
}

test("chrome:// is denied by the allowlist before CDP is touched", async () => {
  const { sw } = await open();
  const tab_id = await openTab(sw, "chrome://version");
  const r = await call(sw, "computer", { action: "screenshot", tab_id });
  assert.ok("error" in r);
  assert.equal(r.error.code, "permission_denied");
});

test("debugger detach by user -> detached_by_user, then reattach", async () => {
  const { sw, baseUrl } = await open();
  const tab_id = await openTab(sw, `${baseUrl}/button.html`);
  imageOf(await call(sw, "computer", { action: "screenshot", tab_id }));
  await sw.evaluate((id) => (globalThis as any).__webop.simulateDetach(id, "canceled_by_user"), tab_id);
  const next = await call(sw, "computer", { action: "screenshot", tab_id });
  assert.ok("error" in next);
  assert.equal(next.error.code, "detached_by_user");
  imageOf(await call(sw, "computer", { action: "screenshot", tab_id }));
});

test("pending send fails with detached_by_user when the user cancels the debugger", async () => {
  const { sw, baseUrl } = await open();
  const tab_id = await openTab(sw, `${baseUrl}/button.html`);
  imageOf(await call(sw, "computer", { action: "screenshot", tab_id }));
  const code = await sw.evaluate(async (id) => {
    const w = (globalThis as any).__webop;
    const pending = w.send(id, "Runtime.evaluate", { expression: "new Promise(r => setTimeout(r, 2000))", awaitPromise: true })
      .then(() => "resolved", (e: { code?: string }) => e.code ?? "no-code");
    await new Promise((r) => setTimeout(r, 200));
    // Real detach first: the pending command rejects before the canceled_by_user event is delivered.
    await w.simulateDetach(id, "canceled_by_user");
    return pending;
  }, tab_id);
  assert.equal(code, "detached_by_user");
  imageOf(await call(sw, "computer", { action: "screenshot", tab_id }));
});

test("unknown tool is invalid_args", async () => {
  const { sw } = await open();
  const r = await call(sw, "read_page" as never, {});
  assert.ok("error" in r);
  assert.equal(r.error.code, "invalid_args");
});

test("background (active:false) session tab: hider resolves by reply, never by timeout", async () => {
  const { sw, baseUrl } = await open();
  const created = await call(sw, "tabs_create", { url: `${baseUrl}/button.html` });
  assert.ok("content" in created);
  const first = created.content[0];
  assert.ok(first.type === "text");
  const tab_id = JSON.parse(first.text).tab_id as number;
  assert.equal(await sw.evaluate((id) => chrome.tabs.get(id).then((t) => t.active), tab_id), false);
  await sw.evaluate(() => { const w = (globalThis as any).__webop; w.hiderLog.length = 0; w.hiderStats.timeouts = 0; });
  imageOf(await call(sw, "computer", { action: "screenshot", tab_id }));
  imageOf(await call(sw, "computer", { action: "screenshot", tab_id }));
  const { log, timeouts } = await sw.evaluate(() => {
    const w = (globalThis as any).__webop;
    return { log: JSON.parse(JSON.stringify(w.hiderLog)) as Array<{ hidden?: boolean; at?: string }>, timeouts: w.hiderStats.timeouts as number };
  });
  const shape = log.map((e) => e.hidden === undefined ? e.at : `hidden:${e.hidden}`);
  assert.deepEqual(shape, ["hidden:true", "before", "after", "hidden:false", "hidden:true", "before", "after", "hidden:false"]);
  assert.equal(timeouts, 0, "overlay content script did not reply in time");
  // The overlay script really is present (otherwise "no timeout" would only mean "no receiver").
  const state = await sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: "webop:overlay_state" }), tab_id);
  assert.equal(state.hidden, false);
});

const ctxOf = (h: Launched, tab_id: number): Promise<ScreenshotContext> =>
  h.sw.evaluate((t) => (globalThis as any).__webop.getContext(t), tab_id);

test("t_zoom_region: a zoom keeps the region's aspect ratio and leaves the coordinate frame alone", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/button.html`);
  imageOf(await call(h.sw, "computer", { action: "screenshot", tab_id }));
  const before = await ctxOf(h, tab_id);
  const r = await call(h.sw, "computer", { action: "zoom", tab_id, region: [0, 0, 200, 100] });
  const img = imageOf(r);
  const { width, height } = jpegSize(Buffer.from(img.data, "base64"));
  assert.ok(Math.abs(width - 2 * height) <= 2, `${width}x${height}`);
  assert.ok("content" in r && r.content[0]?.type === "text" && /coordinates still use the last screenshot frame/.test(r.content[0].text));
  assert.deepEqual(await ctxOf(h, tab_id), before);
  // The old frame still maps clicks: the button sits in the middle of the page.
  const page = h.context.pages().find((p) => p.url().endsWith("/button.html"))!;
  const center = [Math.round(before.screenshotWidth / 2), Math.round(before.screenshotHeight / 2)];
  assert.ok("content" in await call(h.sw, "computer", { action: "left_click", tab_id, coordinate: center }));
  assert.equal(await page.title(), "clicked:true");
});

test("t_zoom_bad_region: inverted or empty regions are invalid_args, outside ones oob", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/button.html`);
  const noCtx = await call(h.sw, "computer", { action: "zoom", tab_id, region: [0, 0, 10, 10] });
  assert.ok("error" in noCtx && noCtx.error.code === "invalid_args");
  imageOf(await call(h.sw, "computer", { action: "screenshot", tab_id }));
  const before = await ctxOf(h, tab_id);
  for (const region of [[100, 100, 50, 200], [10, 10, 10, 40]]) {
    const r = await call(h.sw, "computer", { action: "zoom", tab_id, region });
    assert.ok("error" in r && r.error.code === "invalid_args", JSON.stringify(r).slice(0, 200));
  }
  const oob = await call(h.sw, "computer", { action: "zoom", tab_id, region: [0, 0, 99999, 10] });
  assert.ok("error" in oob && oob.error.code === "oob", JSON.stringify(oob).slice(0, 200));
  const malformed = await call(h.sw, "computer", { action: "zoom", tab_id, region: [0, 0, 10] });
  assert.ok("error" in malformed && malformed.error.code === "invalid_args");
  assert.deepEqual(await ctxOf(h, tab_id), before);
});
