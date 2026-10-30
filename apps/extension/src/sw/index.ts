import { handleDetach, send } from "./cdp.ts";
import { getContext } from "./capture.ts";
import { dispatch } from "./tools.ts";

if (__DEV__) {
  /** Test-only hook: detaches the debugger and runs the same handler Chrome's onDetach event uses. */
  const simulateDetach = async (tabId: number, reason: string): Promise<void> => {
    // API-initiated detach does not fire onDetach, so the event is delivered later, after in-flight commands have rejected.
    await chrome.debugger.detach({ tabId }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    handleDetach(tabId, reason);
  };
  (globalThis as Record<string, unknown>).__webop = { dispatch, getContext, simulateDetach, send };
}
