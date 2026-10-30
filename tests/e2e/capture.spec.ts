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

test("chrome:// is protected_page", async () => {
  const { sw } = await open();
  const tab_id = await openTab(sw, "chrome://version");
  const r = await call(sw, "computer", { action: "screenshot", tab_id });
  assert.ok("error" in r);
  assert.equal(r.error.code, "protected_page");
});

test("debugger detach by user -> detached_by_user, then reattach", async () => {
  const { sw, baseUrl } = await open();
  const tab_id = await openTab(sw, `${baseUrl}/button.html`);
  imageOf(await call(sw, "computer", { action: "screenshot", tab_id }));
  await sw.evaluate((id) => (globalThis as any).__webop.simulateDetach(id, "canceled_by_user"), tab_id);
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
