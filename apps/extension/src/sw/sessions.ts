import { CdpError, detach } from "./cdp.ts";

const COLORS = ["blue", "purple", "cyan", "green", "orange", "pink", "red", "yellow"] as const;
const STORE_KEY = "webop.sessions";

interface SessionState {
  client_name: string;
  color: (typeof COLORS)[number];
  groupId: number | null;
  tabIds: number[];
}
interface Store { created: number; sessions: Record<string, SessionState> }

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
    return (store = saved && typeof saved.created === "number" ? saved : { created: 0, sessions: {} });
  });
  return loading;
}

async function persist(s: Store): Promise<void> {
  await chrome.storage.session.set({ [STORE_KEY]: s });
}

function open(s: Store, session_id: string, client_name: string): SessionState {
  let st = s.sessions[session_id];
  if (!st) {
    st = s.sessions[session_id] = { client_name, color: COLORS[s.created % COLORS.length], groupId: null, tabIds: [] };
    s.created++;
  }
  return st;
}

export async function openSession(session_id: string, client_name: string): Promise<void> {
  await locked(async (s) => {
    if (s.sessions[session_id]) return;
    open(s, session_id, client_name);
    await persist(s);
  });
}

/** Detaches the debugger from the session's tabs and forgets the session; the tabs stay open. */
export async function closeSession(session_id: string): Promise<void> {
  const tabIds = await locked(async (s) => {
    const st = s.sessions[session_id];
    if (!st) return [];
    delete s.sessions[session_id];
    await persist(s);
    return st.tabIds;
  });
  await Promise.all(tabIds.map((id) => detach(id)));
}

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
  return locked(async (s) => {
    const st = open(s, session_id, session_id);
    const tab = await chrome.tabs.create({ url, active: false });
    if (tab.id === undefined) throw new CdpError("internal", "Created tab has no id.");
    await enroll(s, st, tab.id);
    return await chrome.tabs.get(tab.id);
  });
}

/** Test-only: take ownership of an existing tab (used by the dev hook so fixtures can open protected pages). */
export async function adoptTab(session_id: string, tabId: number): Promise<void> {
  await locked(async (s) => enroll(s, open(s, session_id, session_id), tabId));
}

export async function assertOwned(session_id: string, tabId: number): Promise<void> {
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
