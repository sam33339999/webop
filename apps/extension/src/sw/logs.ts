import { makeNetworkEntry, RingLog, type ConsoleEntry, type NetworkEntry } from "@webop/core/logs";
import { siteOf } from "@webop/core/domain";
import { isAttached, onAttached, onDetached, rawCommand } from "./cdp.ts";

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
  /** Recording gaps not yet reported to a reader. */
  gaps: string[];
}

const tabs = new Map<number, TabLogs>();

function logsOf(tabId: number): TabLogs {
  let t = tabs.get(tabId);
  if (!t) tabs.set(tabId, (t = { network: new RingLog(), console: new RingLog(), gaps: [] }));
  return t;
}

export function networkLog(tabId: number): RingLog<NetworkEntry> {
  return logsOf(tabId).network;
}

export function consoleLog(tabId: number): RingLog<ConsoleEntry> {
  return logsOf(tabId).console;
}

export function forgetTab(tabId: number): void {
  tabs.delete(tabId);
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Returns (and forgets) the gaps since the last read, plus a note while recording is paused right now. */
export function takeNotes(tabId: number): string[] {
  const t = logsOf(tabId);
  const notes = t.gaps;
  t.gaps = [];
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

onAttached(async (tabId) => {
  const t = logsOf(tabId);
  const now = Date.now();
  if (t.pausedSince !== undefined) {
    t.gaps.push(`Note: nothing was recorded between ${iso(t.pausedSince)} and ${iso(now)} (debugger detached).`);
    t.pausedSince = undefined;
  }
  // The tab may have moved to another site while we were not listening.
  const url = await chrome.tabs.get(tabId).then((tab) => tab.url ?? "", () => "");
  noteSite(t, url);
  await rawCommand(tabId, "Network.enable", { maxPostDataSize: 0 }).catch(() => {});
  const tree = await rawCommand(tabId, "Page.getFrameTree").catch(() => undefined) as { frameTree?: { frame?: { id?: string } } } | undefined;
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
  frameId?: string;
  type?: string;
  request: { url: string; method: string };
  redirectResponse?: { status: number };
};

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  const t = tabs.get(tabId);
  if (!t) return;
  if (method === "Network.requestWillBeSent") {
    const p = params as RequestWillBeSent;
    const url = p.request.url;
    if (/^(data|blob):/i.test(url)) return;
    if (p.type === "Document" && p.frameId !== undefined && p.frameId === t.topFrame) noteSite(t, url);
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
  } else if (method === "Page.frameNavigated") {
    const f = (params as { frame: { id: string; parentId?: string; url: string } }).frame;
    if (f.parentId !== undefined) return;
    t.topFrame = f.id;
    // Covers top-level moves that send no request (back/forward from the page cache).
    noteSite(t, f.url);
  }
});
