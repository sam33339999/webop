import { devFaults, handleDetach, send, timeouts } from "./cdp.ts";
import { getContext, hiderLog, setOverlayHider } from "./capture.ts";
import { sendWithInject } from "./inject.ts";
import { afterLoad, devHooks, dispatch } from "./tools.ts";
import { adoptTab, closeSession, isOwned, openSession, sessionDevHooks, stopAllSessions, stopEpoch, stopSession, stopSessionsOwning } from "./sessions.ts";
import { ask, promptTimeouts } from "./prompt.ts";
import { grant, requireAccess, migrateAllowList, rearmReady, revokeSite } from "./permissions.ts";
import { cancelCall, openCallContext, PENDING_MARGIN_MS, setPendingSink } from "./callctx.ts";
import { startNativeLink, wakeNativeLink } from "./native.ts";

const HIDER_TIMEOUT_MS = 200;
/** Dev-only: how often the hider gave up waiting for the content script's reply. */
const hiderStats = { timeouts: 0 };

// Hide the phantom overlay while capturing; a missing or slow content script must never fail the action.
setOverlayHider(async (tabId, hidden) => {
  const reply = sendWithInject(tabId, { type: "webop:overlay", hidden }, isOwned).catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), HIDER_TIMEOUT_MS); });
  if ((await Promise.race([reply, timeout])) === "timeout") hiderStats.timeouts++;
  clearTimeout(timer);
});

startNativeLink();
chrome.runtime.onStartup.addListener(startNativeLink);
chrome.runtime.onInstalled.addListener(startNativeLink);
chrome.runtime.onMessage.addListener((msg: { type?: string; site?: unknown }, sender, sendResponse) => {
  // Only our own extension pages may wake the link.
  if (msg?.type === "webop:wake" && sender.id === chrome.runtime.id) wakeNativeLink();
  // Revoke must come from our own options page (never a content script or another extension).
  if (msg?.type === "webop:revoke" && typeof msg.site === "string" && sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("options.html")) {
    revokeSite(msg.site).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  // Stop button in the overlay of an owned tab (a content script of ours, so `sender.tab` is set).
  if (msg?.type === "webop:stop" && sender.id === chrome.runtime.id && sender.tab?.id !== undefined) {
    void stopSessionsOwning(sender.tab.id);
  }
  return false;
});

// The toolbar icon is the stop that page script and page CSS cannot touch: it stops every session of this profile.
const onActionClicked = (): void => { void stopAllSessions(); };
chrome.action.onClicked.addListener(onActionClicked);

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
  /** Test-only: runs ask() the way a gated tool will (pending notice, abortable by tool_cancel, deadline reset after the answer). */
  const askInCall = async (session_id: string, id: string, req: Parameters<typeof ask>[0], then?: Parameters<typeof dispatch>[0]): Promise<{ answer: string; deadlineResetAfter: boolean; result?: unknown }> => {
    const { ctx, close } = openCallContext(session_id, id);
    try {
      ctx.notifyPending(promptTimeouts.askMs + PENDING_MARGIN_MS);
      const before = ctx.deadline;
      const answer = await ask(req, ctx.signal);
      await new Promise((r) => setTimeout(r, 5));
      ctx.resetDeadline();
      const deadlineResetAfter = ctx.deadline > before;
      // Like a gated tool: the action runs only when the user said yes and the call was not abandoned meanwhile.
      if (then && answer !== "deny" && !ctx.signal.aborted) {
        // Hand the id over to the follow-up call's own context so a later cancel reaches it.
        close();
        return { answer, deadlineResetAfter, result: await dispatch(then) };
      }
      return { answer, deadlineResetAfter };
    } finally {
      close();
    }
  };
  /** Test-only: the next Page.captureScreenshot fails once. */
  const failNextCapture = (opts?: { closeSession?: string }): void => {
    devFaults.failNextCapture = true;
    const id = opts?.closeSession;
    devFaults.beforeFail = id === undefined ? undefined : () => closeSession(id);
  };
  (globalThis as Record<string, unknown>).__webop = { askInCall, cancelCall, setPendingSink, setTimeouts, failNextCapture, afterLoad, dispatch, getContext, simulateDetach, send, hiderLog, hiderStats, adoptTab, openSession, stopEpoch, stopSession, sessionDevHooks, actionClicked: onActionClicked, closeSession, ask, promptTimeouts, migrateAllowList, rearmReady, requireAccess, grant, devHooks };
}
