import { devFaults, handleDetach, send, timeouts } from "./cdp.ts";
import { getContext, hiderLog, setOverlayHider } from "./capture.ts";
import { dispatch } from "./tools.ts";
import { adoptTab, closeSession } from "./sessions.ts";
import { startNativeLink, wakeNativeLink } from "./native.ts";

const HIDER_TIMEOUT_MS = 200;
/** Dev-only: how often the hider gave up waiting for the content script's reply. */
const hiderStats = { timeouts: 0 };

// Hide the phantom overlay while capturing; a missing or slow content script must never fail the action.
setOverlayHider(async (tabId, hidden) => {
  const reply = chrome.tabs.sendMessage(tabId, { type: "webop:overlay", hidden }).catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), HIDER_TIMEOUT_MS); });
  if ((await Promise.race([reply, timeout])) === "timeout") hiderStats.timeouts++;
  clearTimeout(timer);
});

startNativeLink();
chrome.runtime.onStartup.addListener(startNativeLink);
chrome.runtime.onInstalled.addListener(startNativeLink);
chrome.runtime.onMessage.addListener((msg: { type?: string }, sender) => {
  // Only our own extension pages may wake the link.
  if (msg?.type === "webop:wake" && sender.id === chrome.runtime.id) wakeNativeLink();
  return false;
});

if (__DEV__) {
  /** Test-only hook: detaches the debugger and runs the same handler Chrome's onDetach event uses. */
  const simulateDetach = async (tabId: number, reason: string): Promise<void> => {
    // API-initiated detach does not fire onDetach, so the event is delivered later, after in-flight commands have rejected.
    await chrome.debugger.detach({ tabId }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    handleDetach(tabId, reason);
  };
  /** Test-only: shortens the CDP send timeout and the per-call deadline. */
  const setTimeouts = (t: { cdpSendMs?: number; callDeadlineMs?: number; probeMs?: number }): void => {
    if (t.cdpSendMs !== undefined) timeouts.cdpSendMs = t.cdpSendMs;
    if (t.callDeadlineMs !== undefined) timeouts.callDeadlineMs = t.callDeadlineMs;
    if (t.probeMs !== undefined) timeouts.probeMs = t.probeMs;
  };
  /** Test-only: the next Page.captureScreenshot fails once. */
  const failNextCapture = (): void => { devFaults.failNextCapture = true; };
  (globalThis as Record<string, unknown>).__webop = { setTimeouts, failNextCapture, dispatch, getContext, simulateDetach, send, hiderLog, hiderStats, adoptTab, closeSession };
}
