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
const detachNotices = new Map<number, number>();
/** Tabs with an open JavaScript dialog (alert/confirm/prompt/beforeunload): commands that run page script stall until it is closed. */
const dialogsOpen = new Set<number>();
const dialogWaiters = new Map<number, Set<() => void>>();
/** Dev-only trace of raw CDP events (proves whether the debugger delivers them at all). */
export const devEvents: string[] = [];
/** Dev-only: CDP methods sent, in order, as `<tabId> <method>` (capped). */
export const devSent: string[] = [];

/** Prod defaults; a page blocked by a dialog or long script must not hold a tab's queue (or land late actions). */
export const timeouts = { cdpSendMs: 20_000, inputSendMs: 3_000, callDeadlineMs: 50_000, probeMs: 2_000 };
const inputCounts = new Map<number, number>();
/** Dev-only fault injection (see the `__webop` hook): makes the next `Page.captureScreenshot` fail once. */
export const devFaults: { failNextCapture: boolean; beforeFail?: () => Promise<void> } = { failNextCapture: false };
const detachListeners: Array<(tabId: number, reason: string) => void> = [];
const attachListeners: Array<(tabId: number) => Promise<void>> = [];

let mayControl: (tabId: number) => boolean = () => true;

/** How many `Input.*` commands have been sent to the tab; lets callers tell whether an action began reaching the page. */
export function inputsSentTo(tabId: number): number {
  return inputCounts.get(tabId) ?? 0;
}

/** Marks a page-changing action (such as a scroll) as begun, so later failures read as "may have happened". */
export function notePageChange(tabId: number): void {
  inputCounts.set(tabId, inputsSentTo(tabId) + 1);
}

/** Registers the check that stops a closed session's in-flight work from re-attaching to its former tabs. */
export function setTabGuard(fn: (tabId: number) => boolean): void {
  mayControl = fn;
}

/** Whether a session still owns the tab (the guard above); false once its session has ended. */
export function isControllable(tabId: number): boolean {
  return mayControl(tabId);
}

function sessionClosed(): CdpError {
  return new CdpError("tab_not_in_session", "This tab is no longer controlled by the session (the session ended or the tab was closed).");
}

// inputCounts is deliberately kept: a tab closing after its first input must still read as "input went out".
chrome.tabs.onRemoved.addListener((tabId) => { halted.delete(tabId); detachNotices.delete(tabId); dialogsOpen.delete(tabId); });

/** True while the page is showing a JavaScript dialog; page-script commands (Runtime.evaluate, probes) hang until then. */
export function isDialogOpen(tabId: number): boolean {
  return dialogsOpen.has(tabId);
}

export function dialogError(): CdpError {
  return new CdpError("timeout", "Not performed: a JavaScript dialog is open in the page; dismiss it and retry.");
}

/** Wakes when a dialog opens on the tab (the caller stops waiting for a command the dialog now holds up). */
function dialogOpened(tabId: number): { promise: Promise<void>; stop: () => void } {
  let waiters = dialogWaiters.get(tabId);
  if (!waiters) dialogWaiters.set(tabId, (waiters = new Set()));
  const set = waiters;
  let wake!: () => void;
  const promise = new Promise<void>((resolve) => { wake = resolve; });
  set.add(wake);
  return {
    promise,
    stop: () => {
      set.delete(wake);
      if (set.size === 0) dialogWaiters.delete(tabId);
    },
  };
}

/**
 * A dialog holds the page's script thread: a command that runs page script would stall its whole timeout (the caller
 * has long since given up), so it is refused at once instead. The exception is the input that opens the dialog — that
 * one is cut short too, but by `send` returning success on `Page.javascriptDialogOpening`.
 */
async function dialogGate(tabId: number, method: string): Promise<void> {
  if (dialogsOpen.has(tabId) && !DIALOG_SAFE.has(method)) throw dialogError();
}
chrome.debugger.onEvent.addListener((source, method) => {
  const tabId = source.tabId;
  if (__DEV__ && devEvents.length < 500) devEvents.push(method);
  if (tabId === undefined) return;
  if (method === "Page.javascriptDialogOpening") {
    dialogsOpen.add(tabId);
    for (const wake of [...(dialogWaiters.get(tabId) ?? [])]) wake();
  } else if (method === "Page.javascriptDialogClosed") dialogsOpen.delete(tabId);
});

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

/** A call that ran while the user cancelled has told its caller already; drop a notice that arose since `since`. */
export function dropDetachNoticeSince(tabId: number, since: number): void {
  const at = detachNotices.get(tabId);
  if (at !== undefined && at >= since) detachNotices.delete(tabId);
}

/** Called when our attachment ends: Chrome's onDetach (or the dev hook), or `"released"` when we detach ourselves. */
export function onDetached(cb: (tabId: number, reason: string) => void): void {
  detachListeners.push(cb);
}

/**
 * Runs after every successful attach, including an attachment re-adopted after a service-worker restart; callbacks are
 * awaited in order before `attach` resolves. They must use `rawCommand`, never `send` (that would attach again).
 */
export function onAttached(cb: (tabId: number) => Promise<void>): void {
  attachListeners.push(cb);
}

export function isAttached(tabId: number): boolean {
  return attached.has(tabId);
}

/** Sends a CDP command on the current attachment without attaching, timeouts or dialog handling. */
export async function rawCommand(tabId: number, method: string, params?: object): Promise<unknown> {
  if (__DEV__ && devSent.length < 2000) devSent.push(`${tabId} ${method}`);
  return chrome.debugger.sendCommand({ tabId }, method, params as Record<string, unknown> | undefined);
}

/** How long an attach listener's command may take: a dialog or a busy page must never hold an attach open. */
export const ATTACH_HOOK_CMD_MS = 2500;

/**
 * `rawCommand` that gives up after `ms` with a `timeout` CdpError. The command itself is left to Chrome (it may still
 * complete later, e.g. once a dialog is dismissed); only our wait ends.
 */
/** True if `p` settles (resolves or rejects) within `ms`; it is never left as an unhandled rejection. */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  try {
    return await Promise.race([p.then(() => true, () => true), late]);
  } finally {
    clearTimeout(timer);
  }
}

export async function rawCommandWithin(tabId: number, method: string, params?: object, ms = ATTACH_HOOK_CMD_MS): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CdpError("timeout", `${method} did not complete within ${ms / 1000}s.`)), ms);
  });
  const command = rawCommand(tabId, method, params);
  // The command may reject after the timeout won; that rejection is not interesting.
  command.catch(() => {});
  try {
    return await Promise.race([command, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function runAttachListeners(tabId: number): Promise<void> {
  for (const cb of attachListeners) await cb(tabId).catch(() => {});
}

/** Single place that reacts to a debugger detach, whether it came from Chrome or from the dev hook. */
export function handleDetach(tabId: number, reason: string): void {
  attached.delete(tabId);
  unsettled.delete(tabId);
  dialogsOpen.delete(tabId);
  lastDetach.set(tabId, { reason, at: Date.now() });
  for (const wake of [...(detachWaiters.get(tabId) ?? [])]) wake();  const waiting = pending.get(tabId);
  if (reason === "canceled_by_user" && !(waiting && waiting.size > 0)) detachNotices.set(tabId, Date.now());
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

async function doAttach(tabId: number, allowBlank: boolean): Promise<void> {
  let url: string | undefined;
  try {
    url = (await chrome.tabs.get(tabId)).url;
  } catch {
    throw new CdpError("tab_not_in_session", `Tab ${tabId} does not exist.`);
  }
  // A freshly created tab sits on about:blank until we navigate it, so recording can start before its first request.
  const blankOk = allowBlank && url === "about:blank";
  if (!blankOk && (!url || !/^https?:\/\//i.test(url))) {
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
      await runAttachListeners(tabId);
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
  // Needed for `Page.javascriptDialogOpening`/`Closed`: a blocked page must be recognized, not waited on. A page whose
  // dialog was already open when we attached never announces it, and leaves every command (this one included)
  // unanswered until the dialog is closed: a Page.enable that does not answer in time marks the tab as blocked, the
  // same as an announced dialog, until the command finally completes.
  const pageEnable = rawCommand(tabId, "Page.enable");
  if (!(await settlesWithin(pageEnable, ATTACH_HOOK_CMD_MS))) {
    dialogsOpen.add(tabId);
    pageEnable.then(() => { if (attached.has(tabId)) dialogsOpen.delete(tabId); }, () => {});
  }
  await runAttachListeners(tabId);
}

/** True once per fresh attach (not for a re-adopted attachment): the caller should let the viewport settle before capturing. */
export function takeFreshAttach(tabId: number): boolean {
  return unsettled.delete(tabId);
}

export async function attach(tabId: number, opts: { allowBlank?: boolean } = {}): Promise<void> {
  if (!mayControl(tabId)) throw sessionClosed();
  if (halted.has(tabId)) throw stoppedError();
  if (attached.has(tabId)) return;
  let inflight = attaching.get(tabId);
  if (!inflight) {
    inflight = doAttach(tabId, opts.allowBlank === true).finally(() => attaching.delete(tabId));
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

/** Commands that still work while a dialog holds the page's script thread. */
const DIALOG_SAFE: ReadonlySet<string> = new Set([
  "Page.captureScreenshot", "Page.enable", "Page.handleJavaScriptDialog", "Emulation.setFocusEmulationEnabled",
]);

export async function send<T = unknown>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
  await attach(tabId);
  if (__DEV__ && devSent.length < 2000) devSent.push(`${tabId} ${method}`);
  await dialogGate(tabId, method);
  let set = pending.get(tabId);
  if (!set) pending.set(tabId, (set = new Set()));
  let abort!: (e: CdpError) => void;
  const aborted = new Promise<never>((_, reject) => { abort = reject; });
  set.add(abort);
  const isInput = method.startsWith("Input.");
  if (isInput) inputCounts.set(tabId, inputsSentTo(tabId) + 1);
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
    // Input has its own, shorter allowance: a click that opens a dialog only gets its reply once the dialog is
    // dismissed, and the agent should not sit through the full send timeout for that.
    const ms = isInput ? timeouts.inputSendMs : timeouts.cdpSendMs;
    timer = setTimeout(() => reject(new CdpError("timeout", `${method} did not complete within ${ms / 1000}s; the page may be blocked by a JavaScript dialog or a long-running script.`)), ms);
  });
  // An input that itself opens a dialog never gets its reply until the dialog is dismissed; the opening proves it landed.
  const dialog = isInput ? dialogOpened(tabId) : null;
  try {
    const command = chrome.debugger.sendCommand({ tabId }, method, params) as Promise<T>;
    const raced: Promise<unknown>[] = [command, aborted, timedOut];
    if (dialog) raced.push(dialog.promise.then(() => undefined));
    return (await Promise.race(raced)) as T;
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
    dialog?.stop();
    set.delete(abort);
  }
}

/** Releases our debugger attachment on a tab (the tab itself is untouched) and clears the bookkeeping. */
export async function detach(tabId: number): Promise<void> {
  const was = attached.has(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
  attached.delete(tabId);
  lastDetach.delete(tabId);
  // Chrome fires no onDetach for an API-initiated detach; tell listeners ourselves.
  if (was) for (const cb of detachListeners) cb(tabId, "released");
}
