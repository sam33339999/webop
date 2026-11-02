import { makeConsoleEntry, makeNetworkEntry, RingLog, type ConsoleEntry, type NetworkEntry } from "@webop/core/logs";
import { siteOf } from "@webop/core/domain";
import { ATTACH_HOOK_CMD_MS, attach, CdpError, dialogError, isAttached, isControllable, isDialogOpen, onAttached, onDetached, rawCommandWithin } from "./cdp.ts";

export type LogKind = "network" | "console";

/**
 * Per-tab console and network buffers, filled from CDP events while we hold the tab's debugger. Memory only: a
 * service-worker restart loses them, and they are dropped when the tab closes or leaves its session.
 */
interface TabLogs {
  network: RingLog<NetworkEntry>;
  console: RingLog<ConsoleEntry>;
  /** Site of the last top-level document, so a move to another site can empty the buffers. */
  site?: string;
  /** Frame id of the top-level frame (only its Document requests count as navigations). */
  topFrame?: string;
  /** When recording stopped (our attachment ended); unset while attached. */
  pausedSince?: number;
  /** Recording gaps not yet reported, per reader: each read tool sees every gap since its own last read. */
  gaps: Record<LogKind, string[]>;
}

const tabs = new Map<number, TabLogs>();

function logsOf(tabId: number): TabLogs {
  let t = tabs.get(tabId);
  if (!t) tabs.set(tabId, (t = { network: new RingLog(), console: new RingLog(), gaps: { network: [], console: [] } }));
  return t;
}

export function networkLog(tabId: number): RingLog<NetworkEntry> {
  return logsOf(tabId).network;
}

export function consoleLog(tabId: number): RingLog<ConsoleEntry> {
  return logsOf(tabId).console;
}

/**
 * Tabs whose console is recorded: `Runtime.enable` is sent only after the first console read asked for it (it is a
 * known bot-detection signal), and again on each later attach. Memory only; a service-worker restart forgets it.
 */
const consoleOn = new Set<number>();

export function consoleEnabled(tabId: number): boolean {
  return consoleOn.has(tabId);
}

/**
 * Starts console recording on the tab, attaching if needed. Callers run it inside the tab's call queue. `Runtime.enable`
 * waits for the page's script thread, so an open dialog (or a busy page) is reported instead of waited on; recording
 * then stays off and the next read tries again.
 */
export async function enableConsole(tabId: number): Promise<void> {
  // Two first reads queued at once: the second finds it done.
  if (consoleOn.has(tabId)) return;
  await attach(tabId);
  if (isDialogOpen(tabId)) throw dialogError();
  try {
    await rawCommandWithin(tabId, "Runtime.enable");
  } catch (e) {
    if (isDialogOpen(tabId)) throw dialogError();
    if (e instanceof CdpError && e.code === "timeout") {
      throw new CdpError("timeout", "Console recording could not be started: the page is not responding (a JavaScript dialog or long-running script may be blocking it). Retry later.");
    }
    throw new CdpError("internal", `Console recording could not be started: ${e instanceof Error ? e.message : String(e)}`);
  }
  consoleOn.add(tabId);
}

export function forgetTab(tabId: number): void {
  tabs.delete(tabId);
  consoleOn.delete(tabId);
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Returns (and forgets) the gaps since this kind's last read, plus a note while recording is paused right now. */
export function takeNotes(tabId: number, kind: LogKind): string[] {
  const t = logsOf(tabId);
  const notes = t.gaps[kind];
  t.gaps[kind] = [];
  if (!isAttached(tabId)) {
    const why = t.pausedSince !== undefined ? ` since ${iso(t.pausedSince)} (debugger detached)` : " (debugger not attached)";
    notes.push(`Note: recording is paused${why}; it resumes on the next browser action on this tab.`);
  }
  return notes;
}

/** Empties both buffers when the tab's top-level document is now on a different site than before. */
function noteSite(t: TabLogs, url: string): void {
  const site = siteOf(url);
  if (site === null) return;
  if (t.site !== undefined && t.site !== site) {
    t.network.clear();
    t.console.clear();
  }
  t.site = site;
}

/**
 * Called by the read tools (no CDP): while detached, nothing tells us that the tab moved to another site, so the
 * buffers are matched against the tab's URL now. `pendingUrl` is the navigation in flight, whose Document request may
 * already have been recorded. If the recorded site is neither, the buffers belong to a site the tab has left: both are
 * emptied and the tab's current site is recorded instead.
 */
export function syncSite(tabId: number, url: string, pendingUrl?: string): void {
  const t = tabs.get(tabId);
  if (!t) return;
  const now = siteOf(url);
  if (t.site === undefined || t.site === now || (pendingUrl !== undefined && t.site === siteOf(pendingUrl))) {
    if (t.site === undefined && now !== null) t.site = now;
    return;
  }
  t.network.clear();
  t.console.clear();
  if (now !== null) t.site = now;
  else t.site = undefined;
}

onAttached(async (tabId) => {
  // An attach that finished after the tab's session ended (and its buffers were forgotten) must not recreate them.
  if (!isControllable(tabId)) return;
  const t = logsOf(tabId);
  const now = Date.now();
  if (t.pausedSince !== undefined) {
    const gap = `Note: nothing was recorded between ${iso(t.pausedSince)} and ${iso(now)} (debugger detached).`;
    t.gaps.network.push(gap);
    if (consoleOn.has(tabId)) t.gaps.console.push(gap);
    t.pausedSince = undefined;
  }
  // The tab may have moved to another site while we were not listening.
  const url = await chrome.tabs.get(tabId).then((tab) => tab.url ?? "", () => "");
  noteSite(t, url);
  // Each command is bounded: a dialog or a busy page must not hold the attach (and the action waiting on it) open. On a
  // page already known to be blocked nothing is waited for. A command that does not answer in time is still pending in
  // Chrome and takes effect once the page is free again; until then that recording counts as off.
  const wait = () => (isDialogOpen(tabId) ? 0 : ATTACH_HOOK_CMD_MS);
  await rawCommandWithin(tabId, "Network.enable", { maxPostDataSize: 0 }, wait()).catch(() => {});
  if (consoleOn.has(tabId)) {
    const enabling = rawCommandWithin(tabId, "Runtime.enable", undefined, wait());
    const ok = await enabling.then(() => true, () => false);
    if (!ok) {
      // The next console read asks again (and reports an open dialog instead of waiting on it).
      consoleOn.delete(tabId);
    }
  }
  const tree = await rawCommandWithin(tabId, "Page.getFrameTree", undefined, wait()).catch(() => undefined) as { frameTree?: { frame?: { id?: string } } } | undefined;
  const id = tree?.frameTree?.frame?.id;
  if (id !== undefined) t.topFrame = id;
});

onDetached((tabId) => {
  const t = tabs.get(tabId);
  if (t && t.pausedSince === undefined) t.pausedSince = Date.now();
});

chrome.tabs.onRemoved.addListener((tabId) => forgetTab(tabId));

type RequestWillBeSent = {
  requestId: string;
  loaderId?: string;
  frameId?: string;
  type?: string;
  request: { url: string; method: string };
  redirectResponse?: { status: number };
};

type RemoteObject = { type?: string; value?: unknown; unserializableValue?: string; description?: string };
type CallFrame = { functionName?: string; url: string; lineNumber: number; columnNumber: number };
type StackTrace = { callFrames?: CallFrame[] };
type ExceptionDetails = {
  text: string; url?: string; lineNumber: number; columnNumber: number; stackTrace?: StackTrace; exception?: RemoteObject;
};

/** One console argument as text: its value (strings as-is, others JSON), else its unserializable value or description. */
function argText(a: RemoteObject): string {
  if (a.value !== undefined) {
    if (typeof a.value === "string") return a.value;
    try {
      return JSON.stringify(a.value) ?? String(a.value);
    } catch {
      return String(a.value);
    }
  }
  return a.unserializableValue ?? a.description ?? (a.type === "undefined" ? "undefined" : "");
}

/** Drops the trailing "    at ..." lines of a V8 error description. */
function withoutStack(description: string): string {
  const lines = description.split("\n");
  while (lines.length > 1 && /^\s+at\s/.test(lines[lines.length - 1])) lines.pop();
  return lines.join("\n");
}

/** Source location (1-based line and column, as DevTools shows them); none for script without a URL. */
function sourceOf(f: CallFrame | undefined): Pick<ConsoleEntry, "url" | "line" | "column"> {
  if (!f || !f.url) return {};
  return { url: f.url, line: f.lineNumber + 1, column: f.columnNumber + 1 };
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  const t = tabs.get(tabId);
  if (!t) return;
  if (method === "Network.requestWillBeSent") {
    const p = params as RequestWillBeSent;
    const url = p.request.url;
    if (/^(data|blob):/i.test(url)) return;
    // Until the top frame id is known, any document load (requestId === loaderId) may be top-level: err on clearing.
    const top = t.topFrame !== undefined ? p.frameId !== undefined && p.frameId === t.topFrame : p.requestId === p.loaderId;
    if (p.type === "Document" && top) noteSite(t, url);
    if (p.redirectResponse) {
      const prev = t.network.find((e) => e.requestId === p.requestId);
      if (prev) prev.status = p.redirectResponse.status;
    }
    t.network.push(makeNetworkEntry({
      requestId: p.requestId, url, method: p.request.method, resourceType: (p.type ?? "Other").toLowerCase(), ts: Date.now(),
    }));
  } else if (method === "Network.responseReceived") {
    const p = params as { requestId: string; response: { status: number } };
    const e = t.network.find((x) => x.requestId === p.requestId);
    if (e) e.status = p.response.status;
  } else if (method === "Network.loadingFailed") {
    const p = params as { requestId: string; errorText: string; canceled?: boolean };
    const e = t.network.find((x) => x.requestId === p.requestId);
    // A request cancelled after its response arrived (e.g. an unread fetch body) keeps the HTTP status it got.
    if (e && !(p.canceled === true && e.status !== undefined)) e.failed = p.errorText;
  } else if (method === "Runtime.consoleAPICalled") {
    const p = params as { type: string; args?: RemoteObject[]; stackTrace?: StackTrace };
    t.console.push(makeConsoleEntry({
      type: p.type === "warning" ? "warn" : p.type,
      text: (p.args ?? []).map(argText).join(" "),
      ...sourceOf(p.stackTrace?.callFrames?.[0]),
      ts: Date.now(),
    }));
  } else if (method === "Runtime.exceptionThrown") {
    const d = (params as { exceptionDetails: ExceptionDetails }).exceptionDetails;
    const frames = d.stackTrace?.callFrames ?? [];
    const entry: ConsoleEntry = {
      type: "exception",
      // V8's description ends with its own stack; that is dropped when the frames are listed below instead.
      text: frames.length > 0 ? withoutStack(d.exception?.description ?? d.text) : d.exception?.description ?? d.text,
      ...(frames.length > 0 ? sourceOf(frames[0]) : sourceOf({ url: d.url ?? "", lineNumber: d.lineNumber, columnNumber: d.columnNumber })),
      ts: Date.now(),
    };
    if (frames.length > 0) {
      entry.stack = frames.map((f) => `at ${f.functionName || "<anonymous>"} (${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1})`).join("\n");
    }
    t.console.push(makeConsoleEntry(entry));
  } else if (method === "Page.frameNavigated") {
    const f = (params as { frame: { id: string; parentId?: string; url: string } }).frame;
    if (f.parentId !== undefined) return;
    t.topFrame = f.id;
    // Covers top-level moves that send no request (back/forward from the page cache).
    noteSite(t, f.url);
  }
});
