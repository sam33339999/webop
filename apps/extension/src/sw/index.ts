import { handleDetach, send } from "./cdp.ts";
import { getContext } from "./capture.ts";
import { dispatch } from "./tools.ts";

if (__DEV__) {
  /** Test-only hook: detaches the debugger and runs the same handler Chrome's onDetach event uses. */
  const simulateDetach = async (tabId: number, reason: string): Promise<void> => {
    handleDetach(tabId, reason);
    await chrome.debugger.detach({ tabId }).catch(() => {});
  };
  (globalThis as Record<string, unknown>).__webop = { dispatch, getContext, simulateDetach, send };
}
