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
const attaching = new Map<number, Promise<void>>();
const pending = new Map<number, Set<(e: CdpError) => void>>();
const userCancels = new Map<number, number>();
const detachListeners: Array<(tabId: number, reason: string) => void> = [];

export function onDetached(cb: (tabId: number, reason: string) => void): void {
  detachListeners.push(cb);
}

/** Single place that reacts to a debugger detach, whether it came from Chrome or from the dev hook. */
export function handleDetach(tabId: number, reason: string): void {
  attached.delete(tabId);
  if (reason === "canceled_by_user") userCancels.set(tabId, (userCancels.get(tabId) ?? 0) + 1);
  const waiting = pending.get(tabId);
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
      return;
    }
    if (e instanceof CdpError) throw e;
    throw new CdpError("attach_failed", `${failure} (${e instanceof Error ? e.message : String(e)})`);
  } finally {
    clearTimeout(timer);
  }
  attached.add(tabId);
}

export async function attach(tabId: number): Promise<void> {
  if (attached.has(tabId)) return;
  let inflight = attaching.get(tabId);
  if (!inflight) {
    inflight = doAttach(tabId).finally(() => attaching.delete(tabId));
    attaching.set(tabId, inflight);
  }
  await inflight;
}

export async function send<T = unknown>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
  await attach(tabId);
  let set = pending.get(tabId);
  if (!set) pending.set(tabId, (set = new Set()));
  let abort!: (e: CdpError) => void;
  const aborted = new Promise<never>((_, reject) => { abort = reject; });
  set.add(abort);
  const cancelsBefore = userCancels.get(tabId) ?? 0;
  try {
    return await Promise.race([chrome.debugger.sendCommand({ tabId }, method, params) as Promise<T>, aborted]);
  } catch (e) {
    if (e instanceof CdpError) throw e;
    // Chrome may reject the in-flight command before our detach handler runs.
    if ((userCancels.get(tabId) ?? 0) > cancelsBefore) {
      throw new CdpError("detached_by_user", "The user closed the debugging session for this tab. Retry to re-attach.");
    }
    throw new CdpError("internal", `${method} failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    set.delete(abort);
  }
}
