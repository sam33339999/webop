import { bumpStopEpoch, cancelSession, stopEpochOf } from "./callctx.ts";
import { ensureInjected, sendWithInject } from "./inject.ts";
import { attach, CdpError, detach, haltTab, onDetached, setTabGuard } from "./cdp.ts";
import { forgetTab } from "./logs.ts";
import { dropSession } from "./gif.ts";
import { abortBackgroundAsks, revokeSessionGrants } from "./permissions.ts";
import type { Budget } from "@webop/core/budget";

const COLORS = ["blue", "purple", "cyan", "green", "orange", "pink", "red", "yellow"] as const;
const GLOW_COLORS: Record<(typeof COLORS)[number], string> = {
  blue: "#3b82f6", purple: "#a855f7", cyan: "#06b6d4", green: "#22c55e", orange: "#f97316", pink: "#ec4899", red: "#ef4444", yellow: "#eab308",
};
const STORE_KEY = "webop.sessions";

interface SessionState {
  client_name: string;
  color: (typeof COLORS)[number];
  groupId: number | null;
  tabIds: number[];
  /** Opened by the native host (as opposed to implicitly); these die with the host connection. */
  host: boolean;
  /** Screenshot budget the agent asked for (`webop mcp --image-max-px` etc.); the default when absent. */
  budget?: Budget;
}
interface Store { created: number; sessions: Record<string, SessionState>; closed: string[] }

const MAX_CLOSED = 500;

/** Dev-only seams for e2e tests (see the `__webop` hook); never set in a production build. */
export const sessionDevHooks: { beforeCreate?: () => Promise<void>; beforeOwnCheck?: () => Promise<void>; beforeClientName?: () => Promise<void> } = {};

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
    store = loaded;
    updateBadge(loaded);
    return loaded;
  });
  return loading;
}

async function persist(s: Store): Promise<void> {
  await chrome.storage.session.set({ [STORE_KEY]: s });
  updateBadge(s);
}

/** The toolbar badge counts the sessions the native host opened (the ones an agent is driving). */
function updateBadge(s: Store): void {
  const n = Object.values(s.sessions).filter((st) => st.host).length;
  chrome.action.setBadgeText({ text: n > 0 ? String(n) : "" }).catch(() => {});
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
export async function openSession(session_id: string, client_name: string, budget?: Budget): Promise<void> {
  await locked(async (s) => {
    s.closed = s.closed.filter((id) => id !== session_id);
    if (s.sessions[session_id]) return;
    const st = open(s, session_id, client_name, true);
    if (budget) st.budget = budget;
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
  const { tabIds, ended } = await locked(async (s) => {
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
    return { tabIds: out, ended: [...ids] };
  });
  for (const id of ended) {
    abortBackgroundAsks(id);
    // Unexported GIF frames die with the session.
    dropSession(id);
  }
  for (const id of tabIds) lit.delete(id);
  // allSettled: a storage failure while revoking must not skip detaching the tabs.
  await Promise.allSettled([
    ...tabIds.map(async (id) => {
      await detach(id);
      forgetTab(id);
      chrome.tabs.sendMessage(id, { type: "webop:session_end" }).catch(() => {});
    }),
    ...ended.map(revokeSessionGrants),
  ]);
}

/** Detaches the debugger from the session's tabs, hides its overlay and forgets the session; the tabs stay open. */
export async function closeSession(session_id: string): Promise<void> {
  cancelSession(session_id);
  await endSessions((id) => id === session_id, [session_id]);
}

export const stopEpoch = stopEpochOf;

/**
 * The user pressed stop: running and queued calls of the session fail with stopped_by_user, unanswered questions are
 * dropped, once-grants are revoked and every tab is released. The session itself stays open, so the agent's next call
 * simply continues (and asks again where it needs to).
 */
export async function stopSession(session_id: string): Promise<void> {
  // Synchronous part first: everything from here on already counts as "after the stop".
  bumpStopEpoch(session_id);
  cancelSession(session_id);
  abortBackgroundAsks(session_id);
  // From the in-memory store the tabs are halted in this same tick, so a running input sequence stops between events.
  // Without the store (the service worker just restarted) nothing of this session can be running.
  const tabsOf = (s: Store): number[] => [...(s.sessions[session_id]?.tabIds ?? [])];
  const tabIds = store ? tabsOf(store) : await locked(tabsOf);
  for (const id of tabIds) {
    haltTab(id);
    lit.delete(id);
    // Sent before anything awaits, so a call that starts right after the stop and lights the tab again is not overruled.
    chrome.tabs.sendMessage(id, { type: "webop:glow", on: false, color: "" }, { frameId: 0 }).catch(() => {});
  }
  await Promise.allSettled([
    ...tabIds.map(detach),
    revokeSessionGrants(session_id),
  ]);
}

const owning = (s: Store, tabId: number): string[] =>
  Object.entries(s.sessions).filter(([, st]) => st.tabIds.includes(tabId)).map(([id]) => id);

/** Stop button in a tab's overlay: stops whichever sessions own that tab. */
export async function stopSessionsOwning(tabId: number): Promise<void> {
  // With the store in memory the stop takes effect synchronously; otherwise load it first.
  const ids = store ? owning(store, tabId) : await locked((s) => owning(s, tabId));
  await Promise.all(ids.map(stopSession));
}

// Cancelling the "is debugging this browser" bar is the user pressing stop for whoever drives that tab.
onDetached((tabId, reason) => {
  if (reason === "canceled_by_user") void stopSessionsOwning(tabId);
});

/** The toolbar icon: the stop the page cannot get in the way of. Stops every session of this profile. */
export async function stopAllSessions(): Promise<void> {
  const ids = store ? Object.keys(store.sessions) : await locked((s) => Object.keys(s.sessions));
  await Promise.all(ids.map(stopSession));
}

/** Tabs whose overlay should be lit (glow + stop button), so a reloaded document gets it back. Cleared by stop and session end. */
const lit = new Map<number, string>();

/**
 * Lights the session's glow (and with it the stop button) on a tab it controls. Best effort.
 * `isStale` is the caller's `ctx.stopped`: a call the user already stopped must not light anything again.
 */
export async function showGlow(session_id: string, tabId: number, isStale: () => boolean = () => false): Promise<void> {
  if (isStale()) return;
  lit.set(tabId, session_id);
  const color = await locked((s) => GLOW_COLORS[s.sessions[session_id]?.color ?? "blue"]);
  // Re-checked at delivery (also after an inject retry): a stop in between has already switched the overlay off.
  // The ownership lookup is the last await: staleness is judged synchronously after it, right before the message goes out.
  const stillWanted = async (id: number): Promise<boolean> => {
    if (__DEV__) await sessionDevHooks.beforeOwnCheck?.();
    const owns = await locked((s) => s.sessions[session_id]?.tabIds.includes(id) ?? false);
    return owns && !isStale() && lit.get(id) === session_id;
  };
  if (!(await stillWanted(tabId))) return;
  await sendWithInject(tabId, { type: "webop:glow", on: true, color }, stillWanted).catch(() => {});
}

/** Sessions belong to one host connection; when that connection ends (or a new one starts) they all go. */
export async function closeHostSessions(): Promise<void> {
  // Only host-driven sessions go; abort their in-flight calls first (nobody is waiting for them any more).
  for (const [id, st] of Object.entries(store?.sessions ?? {})) if (st.host) cancelSession(id);
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

/**
 * Opens a blank background tab, puts it in the session's tab group and attaches the debugger so network recording is
 * running before the first request. It does not navigate: the caller loads the (already checked) URL.
 */
export async function createTab(session_id: string, beforeCreate: () => void = () => {}): Promise<chrome.tabs.Tab> {
  const tabId = await locked(async (s) => {
    if (s.closed.includes(session_id)) throw sessionClosedError();
    if (__DEV__) await sessionDevHooks.beforeCreate?.();
    // The lock wait can be long; a stop (or cancel) that landed meanwhile must not open the tab.
    beforeCreate();
    const st = open(s, session_id, session_id);
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.create({ url: "about:blank", active: false });
    } catch (e) {
      // The profile has no window to put the tab in (normally the link is dropped before an agent can get here).
      if (String(e instanceof Error ? e.message : e).includes("No current window")) {
        throw new CdpError("not_connected", "Not performed: this browser profile has no open window; ask the user to open one, then retry.");
      }
      throw e;
    }
    if (tab.id === undefined) throw new CdpError("internal", "Created tab has no id.");
    await enroll(s, st, tab.id);
    return tab.id;
  });
  // Outside the lock; best effort: without it the tab simply has no recording until the next attach.
  await attach(tabId, { allowBlank: true }).catch(() => {});
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
  lit.delete(tabId);
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
    // A fresh document of a tab that is being operated gets its glow and stop button back.
    const owner = lit.get(tabId);
    if (owner !== undefined) void showGlow(owner, tabId);
    // Ownership may have ended while injecting; make sure nothing of ours stays visible.
    if (!(await isOwned(tabId))) await chrome.tabs.sendMessage(tabId, { type: "webop:session_end" }).catch(() => {});
  })().catch((e) => {
    if (__DEV__) console.warn("webop: content script injection failed", tabId, e);
  });
});

/** The session's screenshot budget, or undefined for the default. */
export async function budgetOf(session_id: string): Promise<Budget | undefined> {
  return locked((s) => s.sessions[session_id]?.budget);
}

/** Name the client gave when it opened the session (what the permission prompt shows); the id itself for implicit sessions. */
export async function clientNameOf(session_id: string): Promise<string> {
  if (__DEV__) await sessionDevHooks.beforeClientName?.();
  return locked((s) => s.sessions[session_id]?.client_name ?? session_id);
}
