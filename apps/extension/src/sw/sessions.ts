import { ensureInjected } from "./inject.ts";
import { CdpError, detach, setTabGuard } from "./cdp.ts";

const COLORS = ["blue", "purple", "cyan", "green", "orange", "pink", "red", "yellow"] as const;
const STORE_KEY = "webop.sessions";

interface SessionState {
  client_name: string;
  color: (typeof COLORS)[number];
  groupId: number | null;
  tabIds: number[];
  /** Opened by the native host (as opposed to implicitly); these die with the host connection. */
  host: boolean;
}
interface Store { created: number; sessions: Record<string, SessionState>; closed: string[] }

const MAX_CLOSED = 500;

let store: Store | undefined;
let loading: Promise<Store> | undefined;
let chain: Promise<unknown> = Promise.resolve();

/** Serialises every read-modify-write of the session map so concurrent tool calls cannot interleave. */
function locked<T>(fn: (s: Store) => Promise<T> | T): Promise<T> {
  const run = chain.then(async () => fn(await load()));
  chain = run.catch(() => {});
  return run;
}

async function load(): Promise<Store> {
  if (store) return store;
  loading ??= chrome.storage.session.get(STORE_KEY).then((r) => {
    const saved = r[STORE_KEY] as Store | undefined;
    const loaded: Store = saved && typeof saved.created === "number" ? saved : { created: 0, sessions: {}, closed: [] };
    loaded.closed ??= [];
    return (store = loaded);
  });
  return loading;
}

async function persist(s: Store): Promise<void> {
  await chrome.storage.session.set({ [STORE_KEY]: s });
}

function sessionClosedError(): CdpError {
  return new CdpError("tab_not_in_session", "Session closed; open a new session.");
}

function open(s: Store, session_id: string, client_name: string, host = false): SessionState {
  let st = s.sessions[session_id];
  if (!st) {
    st = s.sessions[session_id] = { client_name, color: COLORS[s.created % COLORS.length], groupId: null, tabIds: [], host };
    s.created++;
  }
  return st;
}

/** Explicit open from the native host; reopens an id that was closed before. */
export async function openSession(session_id: string, client_name: string): Promise<void> {
  await locked(async (s) => {
    s.closed = s.closed.filter((id) => id !== session_id);
    if (s.sessions[session_id]) return;
    open(s, session_id, client_name, true);
    await persist(s);
  });
}

/** Implicit open for ids never seen before; an id that was explicitly closed stays closed. */
export async function ensureSession(session_id: string): Promise<void> {
  await locked(async (s) => {
    if (s.closed.includes(session_id)) throw sessionClosedError();
    if (s.sessions[session_id]) return;
    open(s, session_id, session_id);
    await persist(s);
  });
}

/** Throws if the session was closed; in-flight calls use this after their await points. */
export async function assertLive(session_id: string): Promise<void> {
  if (await locked((s) => s.closed.includes(session_id))) throw sessionClosedError();
}

/** Forgets the sessions picked by `pick` (closed ids are remembered), then releases their tabs; the tabs stay open. */
async function endSessions(pick: (id: string, st: SessionState) => boolean, alsoClosed: string[] = []): Promise<void> {
  const tabIds = await locked(async (s) => {
    const out: number[] = [];
    const ids = new Set(alsoClosed);
    for (const [id, st] of Object.entries(s.sessions)) {
      if (!pick(id, st)) continue;
      out.push(...st.tabIds);
      ids.add(id);
      delete s.sessions[id];
    }
    for (const id of ids) if (!s.closed.includes(id)) s.closed.push(id);
    if (s.closed.length > MAX_CLOSED) s.closed.splice(0, s.closed.length - MAX_CLOSED);
    await persist(s);
    return out;
  });
  await Promise.all(tabIds.map(async (id) => {
    await detach(id);
    chrome.tabs.sendMessage(id, { type: "webop:session_end" }).catch(() => {});
  }));
}

/** Detaches the debugger from the session's tabs, hides its overlay and forgets the session; the tabs stay open. */
export async function closeSession(session_id: string): Promise<void> {
  await endSessions((id) => id === session_id, [session_id]);
}

/** Sessions belong to one host connection; when that connection ends (or a new one starts) they all go. */
export async function closeHostSessions(): Promise<void> {
  await endSessions((_id, st) => st.host);
}

/** Synchronous ownership check for the CDP attach guard; true while the store is not loaded yet. */
function ownedNow(tabId: number): boolean {
  if (!store) return true;
  return Object.values(store.sessions).some((st) => st.tabIds.includes(tabId));
}
setTabGuard(ownedNow);

async function liveGroup(groupId: number | null): Promise<number | null> {
  if (groupId === null) return null;
  try {
    await chrome.tabGroups.get(groupId);
    return groupId;
  } catch {
    return null;
  }
}

async function enroll(s: Store, st: SessionState, tabId: number): Promise<void> {
  const existing = await liveGroup(st.groupId);
  if (existing !== null) {
    await chrome.tabs.group({ groupId: existing, tabIds: [tabId] });
  } else {
    st.groupId = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(st.groupId, { title: `webop · ${st.client_name}`, color: st.color });
  }
  if (!st.tabIds.includes(tabId)) st.tabIds.push(tabId);
  await persist(s);
}

/** Opens a background tab and puts it in the session's tab group. The caller must have checked the URL. */
export async function createTab(session_id: string, url: string): Promise<chrome.tabs.Tab> {
  const tabId = await locked(async (s) => {
    if (s.closed.includes(session_id)) throw sessionClosedError();
    const st = open(s, session_id, session_id);
    const tab = await chrome.tabs.create({ url, active: false });
    if (tab.id === undefined) throw new CdpError("internal", "Created tab has no id.");
    await enroll(s, st, tab.id);
    return tab.id;
  });
  // Outside the lock; best effort, since a loading page is covered by the onUpdated hook and the lazy inject on first use.
  await ensureInjected(tabId).catch(() => {});
  return await chrome.tabs.get(tabId);
}

/** Test-only: take ownership of an existing tab (used by the dev hook so fixtures can open protected pages). */
export async function adoptTab(session_id: string, tabId: number): Promise<void> {
  await locked(async (s) => enroll(s, open(s, session_id, session_id), tabId));
  await ensureInjected(tabId).catch(() => {});
}

export function isOwned(tabId: number): Promise<boolean> {
  return locked((s) => Object.values(s.sessions).some((st) => st.tabIds.includes(tabId)));
}

export async function assertOwned(session_id: string, tabId: number): Promise<void> {
  await assertLive(session_id);
  const owned = await locked((s) => s.sessions[session_id]?.tabIds.includes(tabId) ?? false);
  if (!owned) throw new CdpError("tab_not_in_session", `Tab ${tabId} does not belong to this session; open tabs with tabs_create.`);
}

export async function listTabs(session_id: string): Promise<{ tab_id: number; title: string; url: string }[]> {
  const ids = await locked((s) => [...(s.sessions[session_id]?.tabIds ?? [])]);
  const out: { tab_id: number; title: string; url: string }[] = [];
  for (const id of ids) {
    try {
      const t = await chrome.tabs.get(id);
      out.push({ tab_id: id, title: t.title ?? "", url: t.url ?? "" });
    } catch {
      // closed in the meantime; onRemoved prunes it
    }
  }
  return out;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void locked(async (s) => {
    let changed = false;
    for (const st of Object.values(s.sessions)) {
      const i = st.tabIds.indexOf(tabId);
      if (i >= 0) { st.tabIds.splice(i, 1); changed = true; }
    }
    if (changed) await persist(s);
  });
});

// A reload or navigation drops the injected scripts; put them back so the overlay and refs keep working.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "complete") return;
  // Not ownedNow(): that is permissive until the store loads, and a foreign tab must never get our scripts.
  void (async () => {
    if (!(await isOwned(tabId))) return;
    await ensureInjected(tabId);
    // Ownership may have ended while injecting; make sure nothing of ours stays visible.
    if (!(await isOwned(tabId))) await chrome.tabs.sendMessage(tabId, { type: "webop:session_end" }).catch(() => {});
  })().catch((e) => {
    if (__DEV__) console.warn("webop: content script injection failed", tabId, e);
  });
});
