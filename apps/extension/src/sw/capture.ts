import type { ContentBlock } from "@webop/core/protocol";
import type { ScreenshotContext } from "@webop/core/coords";
import { planCapture } from "@webop/core/budget";
import { CdpError, attach, isDialogOpen, send, takeFreshAttach } from "./cdp.ts";

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

let hideStopButton: (tabId: number, hidden: boolean) => Promise<void> = async () => {};

export function setOverlayHider(fn: (tabId: number, hidden: boolean) => Promise<void>, stopButton?: (tabId: number, hidden: boolean) => Promise<void>): void {
  hideOverlay = fn;
  if (stopButton) hideStopButton = stopButton;
}

/**
 * Runs `fn` with the stop button hidden: the agent's own input must never land on it. The glow and the phantom cursor
 * stay visible so the user sees each input as it happens. Restored afterwards even when `fn` fails.
 */
export async function withStopButtonHidden<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  await hideStopButton(tabId, true);
  try {
    return await fn();
  } finally {
    await hideStopButton(tabId, false);
  }
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

/** `store: false` takes a picture for the user's eyes (permission prompt) without replacing the context the agent's coordinates are mapped with. */
export async function screenshot(tabId: number, opts: { store?: boolean } = {}): Promise<{ block: ContentBlock; ctx: ScreenshotContext }> {
  await attach(tabId);
  // A dialog freezes the page's script thread, so every probe/settle step here would stall; capture the viewport as-is.
  if (isDialogOpen(tabId)) return dialogScreenshot(tabId);
  try {
    return await fullScreenshot(tabId, opts);
  } catch (e) {
    // The dialog may have opened while we were already busy (the probe hangs); everything it needs is browser-side.
    if (!(e instanceof CdpError) || e.code !== "timeout") throw e;
    return dialogScreenshot(tabId);
  }
}

async function fullScreenshot(tabId: number, opts: { store?: boolean }): Promise<{ block: ContentBlock; ctx: ScreenshotContext }> {
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
    if (opts.store !== false) contexts.set(tabId, ctx);
    return { block: { type: "image", data, mimeType: "image/jpeg" }, ctx };
  } finally {
    if (__DEV__) hiderLog.push({ tabId, hidden: false });
    await hideOverlay(tabId, false);
  }
}

/**
 * The page is blocked by a dialog, and so is `Page.captureScreenshot` (it waits for the page). The extension API
 * captures the visible tab without the debugger instead; the previous coordinate frame is kept, since the still-open
 * dialog means the page cannot have moved.
 */
async function dialogScreenshot(tabId: number): Promise<{ block: ContentBlock; ctx: ScreenshotContext }> {
  const ctx = getContext(tabId) ?? { viewportWidth: 0, viewportHeight: 0, screenshotWidth: 0, screenshotHeight: 0 };
  takeFreshAttach(tabId);
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  // The content script cannot run while the dialog blocks the page, so the hider is not awaited (nothing else needs it).
  void hideOverlay(tabId, true).catch(() => {});
  if (tab) {
    try {
      const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: JPEG_QUALITY });
      const data = url.slice(url.indexOf(",") + 1);
      return { block: { type: "image", data, mimeType: "image/jpeg" }, ctx };
    } catch {
      // e.g. the window is minimised: report the action without a picture.
    }
  }
  return { block: { type: "text", text: "No screenshot available while a dialog is open." }, ctx };
}
