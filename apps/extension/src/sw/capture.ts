import type { ContentBlock } from "@webop/core/protocol";
import type { ScreenshotContext } from "@webop/core/coords";
import { DEFAULT_BUDGET, planCapture, type Budget } from "@webop/core/budget";
import { toViewport } from "@webop/core/coords";
import { CdpError, attach, dialogError, isDialogOpen, send, takeFreshAttach } from "./cdp.ts";

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
export async function screenshot(tabId: number, opts: { store?: boolean; budget?: Budget } = {}): Promise<{ block: ContentBlock; ctx: ScreenshotContext }> {
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

/**
 * A background tab in a real browser renders no frames, and input sent to it (Input.dispatch*) is not processed until
 * one is produced, so the command just hangs. Focus emulation plus a forced 1x1 capture makes the tab render.
 * (Headless Chromium keeps rendering background tabs, so tests there never stall either way.)
 */
async function wake(tabId: number, p?: PageProbe): Promise<void> {
  await send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
  const probed = p ?? await probe(tabId);
  if (probed.visibility !== "visible") {
    await send(tabId, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 1,
      clip: { x: probed.scrollX, y: probed.scrollY, width: 1, height: 1, scale: 1 },
    });
  }
}

/** Run before sending input to a tab: the agent's tabs are opened in the background and may not be rendering. */
export async function prepareForInput(tabId: number): Promise<void> {
  if (isDialogOpen(tabId)) return;
  await wake(tabId);
}

async function fullScreenshot(tabId: number, opts: { store?: boolean; budget?: Budget }): Promise<{ block: ContentBlock; ctx: ScreenshotContext }> {
  if (takeFreshAttach(tabId)) await waitForStableViewport(tabId);
  await send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
  if (__DEV__) hiderLog.push({ tabId, hidden: true });
  await hideOverlay(tabId, true);
  try {
    await new Promise((resolve) => setTimeout(resolve, OVERLAY_SETTLE_MS));
    const p = await probe(tabId);
    // A hidden tab produces no frames until the browser is forced to render one.
    await wake(tabId, p);
    const { clipScale, outWidth, outHeight } = planCapture(p.width, p.height, p.dpr, opts.budget ?? DEFAULT_BUDGET);
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

/**
 * A close-up of `region` ([x0, y0, x1, y1] in the last screenshot's frame), at up to device resolution within the budget.
 * The tab's coordinate frame is left alone: coordinates keep referring to the last full screenshot.
 */
export async function zoom(tabId: number, region: [number, number, number, number], budget: Budget = DEFAULT_BUDGET): Promise<{ block: ContentBlock; width: number; height: number }> {
  const ctx = getContext(tabId);
  if (!ctx) throw new CdpError("invalid_args", "No screenshot context for this tab; take a screenshot first.");
  const [x0, y0, x1, y1] = region;
  if (!(x1 > x0 && y1 > y0)) throw new CdpError("invalid_args", "region must be [x0, y0, x1, y1] with x1 > x0 and y1 > y0.");
  const a = toViewport(x0, y0, ctx);
  if ("oobError" in a) throw new CdpError("oob", a.oobError);
  const b = toViewport(x1, y1, ctx);
  if ("oobError" in b) throw new CdpError("oob", b.oobError);
  await attach(tabId);
  if (isDialogOpen(tabId)) throw dialogError();
  const p = await probe(tabId);
  if (p.width !== ctx.viewportWidth || p.height !== ctx.viewportHeight) {
    throw new CdpError("invalid_args", `Not performed: the viewport changed size since the last screenshot (${ctx.viewportWidth}x${ctx.viewportHeight} → ${p.width}x${p.height}); take a new screenshot first.`);
  }
  const left = Math.min(a.viewport[0], p.width - 1);
  const top = Math.min(a.viewport[1], p.height - 1);
  const width = Math.max(1, Math.min(b.viewport[0], p.width) - left);
  const height = Math.max(1, Math.min(b.viewport[1], p.height) - top);
  const { clipScale, outWidth, outHeight } = planCapture(width, height, p.dpr, budget);
  await hideOverlay(tabId, true);
  try {
    await new Promise((resolve) => setTimeout(resolve, OVERLAY_SETTLE_MS));
    const { data } = await send<{ data: string }>(tabId, "Page.captureScreenshot", {
      format: "jpeg",
      quality: JPEG_QUALITY,
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { x: p.scrollX + left, y: p.scrollY + top, width, height, scale: clipScale },
    });
    return { block: { type: "image", data, mimeType: "image/jpeg" }, width: outWidth, height: outHeight };
  } finally {
    await hideOverlay(tabId, false);
  }
}
