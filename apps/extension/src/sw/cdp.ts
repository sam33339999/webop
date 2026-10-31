import type { ErrorCode } from "@webop/core/protocol";

export class CdpError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "CdpError";
    this.code = code;
  }
}

const PROTOCOL_VERSION = "1.3";
const ATTACH_TIMEOUT_MS = 5000;

const attached = new Set<number>();
/** Tabs attached by us whose first capture has not yet waited for the viewport to settle (the debugging infobar resizes the page). */
const unsettled = new Set<number>();
const attaching = new Map<number, Promise<void>>();
const pending = new Map<number, Set<(e: CdpError) => void>>();
const lastDetach = new Map<number, { reason: string; at: number }>();
const detachWaiters = new Map<number, Set<() => void>>();
const CANCEL_GRACE_MS = 100;
/** Tabs a stop just released: nothing may re-attach to them until a call that started after the stop takes its turn. */
const halted = new Set<number>();
/** Tabs whose debugger bar the user cancelled while no command was waiting; the next call on them says so once. */
const detachNotices = new Set<number>();

/** Prod defaults; a page blocked by a dialog or long script must not hold a tab's queue (or land late actions). */
export const timeouts = { cdpSendMs: 20_000, callDeadlineMs: 50_000, probeMs: 2_000 };
const inputCounts = new Map<number, number>();
/** Dev-only fault injection (see the `__webop` hook): makes the next `Page.captureScreenshot` fail once. */
export const devFaults: { failNextCapture: boolean; beforeFail?: () => Promise<void> } = { failNextCapture: false };
const detachListeners: Array<(tabId: number, reason: string) => void> = [];

let mayControl: (tabId: number) => boolean = () => true;

/** How many `Input.*` commands have been sent to the tab; lets callers tell whether an action began reaching the page. */
export function inputsSentTo(tabId: number): number {
  return inputCounts.get(tabId) ?? 0;
}

/** Registers the check that stops a closed session's in-flight work from re-attaching to its former tabs. */
export function setTabGuard(fn: (tabId: number) => boolean): void {
  mayControl = fn;
}

function sessionClosed(): CdpError {
  return new CdpError("tab_not_in_session", "This tab is no longer controlled by the session (the session ended or the tab was closed).");
}

chrome.tabs.onRemoved.addListener((tabId) => { inputCounts.delete(tabId); halted.delete(tabId); detachNotices.delete(tabId); });

export function stoppedError(): CdpError {
  return new CdpError("stopped_by_user", "Not performed: the user pressed stop.");
}

/** After a stop: refuse to attach (and so to send anything) to the tab until `resumeTab`. */
export function haltTab(tabId: number): void {
  halted.add(tabId);
}
export function resumeTab(tabId: number): void {
  halted.delete(tabId);
}

/** True once after the user cancelled the debugger bar on this tab and no running command had been told yet. */
export function takeDetachNotice(tabId: number): boolean {
  return detachNotices.delete(tabId);
}

export function onDetached(cb: (tabId: number, reason: string) => void): void {
  detachListeners.push(cb);
}

/** Single place that reacts to a debugger detach, whether it came from Chrome or from the dev hook. */
export function handleDetach(tabId: number, reason: string): void {
  attached.delete(tabId);
  unsettled.delete(tabId);
  lastDetach.set(tabId, { reason, at: Date.now() });
  for (const wake of [...(detachWaiters.get(tabId) ?? [])]) wake();
  const waiting = pending.get(tabId);
  if (reason === "canceled_by_user" && !(waiting && waiting.size > 0)) detachNotices.add(tabId);
  if (waiting && reason === "canceled_by_user") {
    for (const reject of [...waiting]) {
      reject(new CdpError("detached_by_user", "The user closed the debugging session for this tab. Retry to re-attach."));
    }
  }
  for (const cb of detachListeners) cb(tabId, reason);
}

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId !== undefined) handleDetach(source.tabId, reason);
});

async function isAttachedByUs(tabId: number): Promise<boolean> {
  const targets = await chrome.debugger.getTargets();
  return targets.some((t) => t.tabId === tabId && t.attached && t.extensionId === chrome.runtime.id);
}

async function doAttach(tabId: number): Promise<void> {
  let url: string | undefined;
  try {
    url = (await chrome.tabs.get(tabId)).url;
  } catch {
    throw new CdpError("tab_not_in_session", `Tab ${tabId} does not exist.`);
  }
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new CdpError("protected_page", `Cannot automate this page (${url ?? "unknown URL"}); only http(s) pages are supported.`);
  }
  const failure = "DevTools may be open on this tab, or the renderer may have crashed";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CdpError("attach_failed", failure)), ATTACH_TIMEOUT_MS);
  });
  try {
    await Promise.race([chrome.debugger.attach({ tabId }, PROTOCOL_VERSION), timeout]);
  } catch (e) {
    // After a service-worker restart Chrome may still hold our earlier attachment.
    if (!(e instanceof CdpError) && await isAttachedByUs(tabId)) {
      attached.add(tabId);
      lastDetach.delete(tabId);
      return;
    }
    if (e instanceof CdpError) throw e;
    throw new CdpError("attach_failed", `${failure} (${e instanceof Error ? e.message : String(e)})`);
  } finally {
    clearTimeout(timer);
  }
  attached.add(tabId);
  unsettled.add(tabId);
  lastDetach.delete(tabId);
}

/** True once per fresh attach (not for a re-adopted attachment): the caller should let the viewport settle before capturing. */
export function takeFreshAttach(tabId: number): boolean {
  return unsettled.delete(tabId);
}

export async function attach(tabId: number): Promise<void> {
  if (!mayControl(tabId)) throw sessionClosed();
  if (halted.has(tabId)) throw stoppedError();
  if (attached.has(tabId)) return;
  let inflight = attaching.get(tabId);
  if (!inflight) {
    inflight = doAttach(tabId).finally(() => attaching.delete(tabId));
    attaching.set(tabId, inflight);
  }
  await inflight;
  // The session may have been closed while the attach was in flight; never leave a debugger behind.
  if (!mayControl(tabId)) {
    await detach(tabId);
    throw sessionClosed();
  }
}

function waitForDetach(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let waiters = detachWaiters.get(tabId);
    if (!waiters) detachWaiters.set(tabId, (waiters = new Set()));
    const set = waiters;
    const done = () => {
      clearTimeout(timer);
      set.delete(done);
      if (set.size === 0) detachWaiters.delete(tabId);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    set.add(done);
  });
}

export async function send<T = unknown>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
  await attach(tabId);
  let set = pending.get(tabId);
  if (!set) pending.set(tabId, (set = new Set()));
  let abort!: (e: CdpError) => void;
  const aborted = new Promise<never>((_, reject) => { abort = reject; });
  set.add(abort);
  if (method.startsWith("Input.")) inputCounts.set(tabId, inputsSentTo(tabId) + 1);
  if (__DEV__ && method === "Page.captureScreenshot" && devFaults.failNextCapture) {
    devFaults.failNextCapture = false;
    await devFaults.beforeFail?.();
    set.delete(abort);
    throw new CdpError("internal", "Page.captureScreenshot failed: injected fault");
  }
  const startedAt = Date.now();
  const canceledSince = () => {
    const d = lastDetach.get(tabId);
    return d !== undefined && d.reason === "canceled_by_user" && d.at >= startedAt;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    const ms = timeouts.cdpSendMs;
    timer = setTimeout(() => reject(new CdpError("timeout", `${method} did not complete within ${ms / 1000}s; the page may be blocked by a JavaScript dialog or a long-running script.`)), ms);
  });
  try {
    return await Promise.race([chrome.debugger.sendCommand({ tabId }, method, params) as Promise<T>, aborted, timedOut]);
  } catch (e) {
    if (e instanceof CdpError) throw e;
    if (!(await chrome.tabs.get(tabId).then(() => true, () => false))) {
      throw new CdpError("tab_not_in_session", `Tab ${tabId} was closed.`);
    }
    if (!mayControl(tabId)) throw sessionClosed();
    // Chrome may reject the in-flight command before onDetach(canceled_by_user) fires, so give the event a moment.
    if (!canceledSince()) await waitForDetach(tabId, CANCEL_GRACE_MS);
    if (canceledSince()) {
      throw new CdpError("detached_by_user", "The user closed the debugging session for this tab. Retry to re-attach.");
    }
    throw new CdpError("internal", `${method} failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
    set.delete(abort);
  }
}

/** Releases our debugger attachment on a tab (the tab itself is untouched) and clears the bookkeeping. */
export async function detach(tabId: number): Promise<void> {
  await chrome.debugger.detach({ tabId }).catch(() => {});
  attached.delete(tabId);
  lastDetach.delete(tabId);
}
