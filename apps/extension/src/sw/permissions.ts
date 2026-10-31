import { siteOf } from "@webop/core/domain";
import { decide, type Level, type Policy, type Scope } from "@webop/core/grants";
import { CdpError } from "./cdp.ts";
import { ask } from "./prompt.ts";

const GRANTS_KEY = "webop.grants";
const DENY_KEY = "webop.deny";
const JS_KEY = "webop.js_enabled";
const SESSION_GRANTS_KEY = "webop.session_grants";
/** M3's flat allowlist; read once by migrateAllowList, then deleted. */
const LEGACY_ALLOW_KEY = "webop.allow";

type GrantMap = Record<string, Level[]>;
const LEVELS: readonly string[] = ["read", "act", "javascript"];

function cleanMap(v: unknown): GrantMap {
  const out: GrantMap = {};
  if (typeof v !== "object" || v === null || Array.isArray(v)) return out;
  for (const [site, levels] of Object.entries(v)) {
    if (Array.isArray(levels)) out[site] = levels.filter((l): l is Level => typeof l === "string" && LEVELS.includes(l));
  }
  return out;
}

function levelsOf(m: GrantMap, site: string): Level[] {
  return Object.hasOwn(m, site) ? m[site]! : [];
}

// Read-modify-write on storage must not interleave.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function readAlways(): Promise<GrantMap> {
  return cleanMap((await chrome.storage.local.get(GRANTS_KEY))[GRANTS_KEY]);
}
async function readOnce(): Promise<Record<string, GrantMap>> {
  const raw = (await chrome.storage.session.get(SESSION_GRANTS_KEY))[SESSION_GRANTS_KEY];
  const out: Record<string, GrantMap> = {};
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    for (const [id, m] of Object.entries(raw)) out[id] = cleanMap(m);
  }
  return out;
}

/** Everything `decide` needs for one session: permanent + this session's `once` grants, deny list and the JS switch. */
export async function loadPolicy(session_id: string): Promise<Policy> {
  await ready;
  const stored = await chrome.storage.local.get([DENY_KEY, JS_KEY]);
  const deny = Array.isArray(stored[DENY_KEY]) ? stored[DENY_KEY].filter((s: unknown): s is string => typeof s === "string") : [];
  const onceAll = await readOnce();
  const once = Object.hasOwn(onceAll, session_id) ? onceAll[session_id]! : {};
  return { always: await readAlways(), once, deny, jsEnabled: stored[JS_KEY] === true };
}

export function grant(session_id: string, site: string, level: Level, scope: Scope): Promise<void> {
  return serial(async () => {
    if (scope === "always") {
      const m = await readAlways();
      const cur = levelsOf(m, site);
      if (!cur.includes(level)) m[site] = [...cur, level];
      await chrome.storage.local.set({ [GRANTS_KEY]: m });
      return;
    }
    const all = await readOnce();
    const m = Object.hasOwn(all, session_id) ? all[session_id]! : {};
    const cur = levelsOf(m, site);
    if (!cur.includes(level)) m[site] = [...cur, level];
    all[session_id] = m;
    await chrome.storage.session.set({ [SESSION_GRANTS_KEY]: all });
  });
}

/** Removes every level of `site` from the permanent grants (options page revoke, via the SW so it shares the write chain). */
export function revokeSite(site: string): Promise<void> {
  return serial(async () => {
    const m = await readAlways();
    if (!Object.hasOwn(m, site)) return;
    delete m[site];
    await chrome.storage.local.set({ [GRANTS_KEY]: m });
  });
}

export function revokeSessionGrants(session_id: string): Promise<void> {
  return serial(async () => {
    const all = await readOnce();
    if (!Object.hasOwn(all, session_id)) return;
    delete all[session_id];
    await chrome.storage.session.set({ [SESSION_GRANTS_KEY]: all });
  });
}

/** One-time M3 -> M4 migration: `webop.allow` sites become `act` grants, then the old key is removed. */
export function migrateAllowList(): Promise<void> {
  return serial(async () => {
    const stored = (await chrome.storage.local.get(LEGACY_ALLOW_KEY))[LEGACY_ALLOW_KEY];
    if (stored === undefined) return;
    const m = await readAlways();
    if (Array.isArray(stored)) {
      for (const s of stored) {
        if (typeof s !== "string" || !s.trim()) continue;
        const entry = s.trim();
        const site = siteOf(entry.includes("://") ? entry : `https://${entry}`)?.toLowerCase();
        if (!site) continue;
        const cur = levelsOf(m, site);
        if (!cur.includes("act")) m[site] = [...cur, "act"];
      }
    }
    await chrome.storage.local.set({ [GRANTS_KEY]: m });
    await chrome.storage.local.remove(LEGACY_ALLOW_KEY);
  });
}

/** Resolves once the startup migration has finished (it never rejects); every read of the grant store waits on it. */
export let ready: Promise<void> = startMigration();
function startMigration(): Promise<void> {
  return migrateAllowList().catch((e) => console.warn("webop allowlist migration failed", e));
}
/** Test-only: runs the migration again and makes reads wait for it, as after a fresh SW start. */
export function rearmReady(): Promise<void> {
  return (ready = startMigration());
}

/** Whether `tabs_list` may show this tab's URL/title: the site is not denied and the session (or a permanent grant) holds at least `read`. */
export async function isSiteReadable(session_id: string, url: string): Promise<boolean> {
  return decide(await loadPolicy(session_id), siteOf(url), "read") === "allow";
}

export interface AccessRequest {
  session_id: string;
  client_name: string;
  url: string;
  level: Level;
  tabId?: number;
  /** Intended click position in viewport CSS px (shown to the user only). */
  marker?: { x: number; y: number };
  signal?: AbortSignal;
  /** Called right before the user is asked (the caller extends its timeout / marks the call as waiting). */
  beforeAsk?: () => void;
  /** Completes "Not performed: ..." in the refusal message. */
  what?: string;
}

/** What the grant model says about `url` right now, without asking anyone. */
export async function accessState(session_id: string, url: string, level: Level): Promise<"allow" | "deny" | "ask"> {
  return decide(await loadPolicy(session_id), siteOf(url), level);
}

function siteLabel(site: string | null): string {
  return site === null ? "this page (not an http(s) site)" : `site "${site}"`;
}

/** permission_denied for a refused site (deny list, non-web page); `note` says what was or was not performed. */
export function deniedError(url: string, note = "Not performed"): CdpError {
  const site = siteOf(url);
  const why = site === null ? "is not an http(s) page, which webop never touches" : "is on the deny list in webop options";
  return new CdpError("permission_denied", `${note}: ${siteLabel(site)} ${why}.`);
}

/**
 * Lets the call proceed only if the session holds `level` on the URL's site: allowed -> returns; deny list -> permission_denied;
 * otherwise asks the user and persists a yes (once -> this session, always -> permanent); a no, timeout or abort -> permission_denied.
 */
export async function requireAccess(o: AccessRequest): Promise<void> {
  const site = siteOf(o.url);
  const state = decide(await loadPolicy(o.session_id), site, o.level);
  if (state === "allow") return;
  if (state === "deny" || site === null) throw deniedError(o.url);
  o.beforeAsk?.();
  const answer = await ask({ session_id: o.session_id, client_name: o.client_name, site, level: o.level, tabId: o.tabId, marker: o.marker }, o.signal);
  if (o.signal?.aborted) throw new CdpError("timeout", "Not performed: the caller cancelled this call.");
  if (answer === "deny") {
    throw new CdpError("permission_denied", `Not performed: the user declined (or did not answer) ${o.level} access to ${siteLabel(site)}; ${o.what ?? "nothing was done"}.`);
  }
  await grant(o.session_id, site, o.level, answer === "always" ? "always" : "once");
}

/** Shows the question without waiting for it (the call itself is already answered); a yes is stored for the retry. */
export function askInBackground(o: Omit<AccessRequest, "signal" | "beforeAsk" | "what">): void {
  void (async () => {
    const site = siteOf(o.url);
    if (site === null || decide(await loadPolicy(o.session_id), site, o.level) !== "ask") return;
    const answer = await ask({ session_id: o.session_id, client_name: o.client_name, site, level: o.level, tabId: o.tabId, marker: o.marker });
    if (answer !== "deny") await grant(o.session_id, site, o.level, answer === "always" ? "always" : "once");
  })().catch(() => {});
}
