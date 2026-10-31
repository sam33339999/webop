import type { ContentBlock } from "@webop/core/protocol";
import type { ScreenshotContext } from "@webop/core/coords";
import { planCapture } from "@webop/core/budget";
import { attach, send, takeFreshAttach } from "./cdp.ts";

const JPEG_QUALITY = 75;
const OVERLAY_SETTLE_MS = 50;
/** After a fresh debugger attach the infobar resizes the page; wait until innerWidth/innerHeight stay put. */
const VIEWPORT_POLL_MS = 50;
const VIEWPORT_STABLE_MS = 200;
const VIEWPORT_SETTLE_MAX_MS = 1500;

const contexts = new Map<number, ScreenshotContext>();
let hideOverlay: (tabId: number, hidden: boolean) => Promise<void> = async () => {};

/**
 * Dev-only trace of one screenshot, in order:
 * `{tabId, hidden:true}` -> `{tabId, at:"before"}` (just before the main Page.captureScreenshot)
 * -> `{tabId, at:"after"}` (just after) -> `{tabId, hidden:false}`.
 */
export const hiderLog: Array<{ tabId: number; hidden?: boolean; at?: "before" | "after" }> = [];

export function setOverlayHider(fn: (tabId: number, hidden: boolean) => Promise<void>): void {
  hideOverlay = fn;
}

export function getContext(tabId: number): ScreenshotContext | undefined {
  return contexts.get(tabId);
}

interface PageProbe {
  width: number;
  height: number;
  dpr: number;
  scrollX: number;
  scrollY: number;
  visibility: string;
}

async function probe(tabId: number): Promise<PageProbe> {
  const r = await send<{ result: { value: PageProbe } }>(tabId, "Runtime.evaluate", {
    expression: `({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio || 1, scrollX, scrollY, visibility: document.visibilityState })`,
    returnByValue: true,
  });
  return r.result.value;
}

async function waitForStableViewport(tabId: number): Promise<void> {
  const start = Date.now();
  let last = "";
  let since = start;
  for (;;) {
    const p = await probe(tabId);
    const now = Date.now();
    const size = `${p.width}x${p.height}`;
    if (size !== last) { last = size; since = now; }
    if (now - since >= VIEWPORT_STABLE_MS || now - start >= VIEWPORT_SETTLE_MAX_MS) return;
    await new Promise((resolve) => setTimeout(resolve, VIEWPORT_POLL_MS));
  }
}

export async function screenshot(tabId: number): Promise<{ block: ContentBlock; ctx: ScreenshotContext }> {
  await attach(tabId);
  if (takeFreshAttach(tabId)) await waitForStableViewport(tabId);
  await send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
  if (__DEV__) hiderLog.push({ tabId, hidden: true });
  await hideOverlay(tabId, true);
  try {
    await new Promise((resolve) => setTimeout(resolve, OVERLAY_SETTLE_MS));
    const p = await probe(tabId);
    if (p.visibility !== "visible") {
      // A hidden tab produces no frames until the browser is forced to render one.
      await send(tabId, "Page.captureScreenshot", {
        format: "jpeg",
        quality: 1,
        clip: { x: p.scrollX, y: p.scrollY, width: 1, height: 1, scale: 1 },
      });
    }
    const { clipScale, outWidth, outHeight } = planCapture(p.width, p.height, p.dpr);
    if (__DEV__) hiderLog.push({ tabId, at: "before" });
    const { data } = await send<{ data: string }>(tabId, "Page.captureScreenshot", {
      format: "jpeg",
      quality: JPEG_QUALITY,
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { x: p.scrollX, y: p.scrollY, width: p.width, height: p.height, scale: clipScale },
    });
    if (__DEV__) hiderLog.push({ tabId, at: "after" });
    const ctx: ScreenshotContext = {
      viewportWidth: p.width,
      viewportHeight: p.height,
      screenshotWidth: outWidth,
      screenshotHeight: outHeight,
    };
    contexts.set(tabId, ctx);
    return { block: { type: "image", data, mimeType: "image/jpeg" }, ctx };
  } finally {
    if (__DEV__) hiderLog.push({ tabId, hidden: false });
    await hideOverlay(tabId, false);
  }
}
