import { handleDetach, send } from "./cdp.ts";
import { getContext, hiderLog, setOverlayHider } from "./capture.ts";
import { dispatch } from "./tools.ts";
import { adoptTab, closeSession } from "./sessions.ts";

const HIDER_TIMEOUT_MS = 200;

// Hide the phantom overlay while capturing; a missing or slow content script must never fail the action.
setOverlayHider(async (tabId, hidden) => {
  const reply = chrome.tabs.sendMessage(tabId, { type: "webop:overlay", hidden }).catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, HIDER_TIMEOUT_MS); });
  await Promise.race([reply, timeout]);
  clearTimeout(timer);
});

if (__DEV__) {
  /** Test-only hook: detaches the debugger and runs the same handler Chrome's onDetach event uses. */
  const simulateDetach = async (tabId: number, reason: string): Promise<void> => {
    // API-initiated detach does not fire onDetach, so the event is delivered later, after in-flight commands have rejected.
    await chrome.debugger.detach({ tabId }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    handleDetach(tabId, reason);
  };
  (globalThis as Record<string, unknown>).__webop = { dispatch, getContext, simulateDetach, send, hiderLog, adoptTab, closeSession };
}
