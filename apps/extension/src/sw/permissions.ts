import { siteOf } from "@webop/core/domain";
import { covers, decide, type Level, type Policy, type Scope } from "@webop/core/grants";
import { CdpError } from "./cdp.ts";

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
        const site = s.trim().toLowerCase();
        const cur = levelsOf(m, site);
        if (!cur.includes("act")) m[site] = [...cur, "act"];
      }
    }
    await chrome.storage.local.set({ [GRANTS_KEY]: m });
    await chrome.storage.local.remove(LEGACY_ALLOW_KEY);
  });
}

/** Whether `tabs_list` may show this tab's URL/title: the site is not denied and the session (or a permanent grant) holds at least `read`. */
export async function isSiteReadable(session_id: string, url: string): Promise<boolean> {
  return decide(await loadPolicy(session_id), siteOf(url), "read") === "allow";
}

/**
 * Interim gate until Task 5 replaces it with requireAccess: throws permission_denied unless the site's
 * permanent grants cover `act` (same behaviour as M3's allowlist).
 */
export async function checkSite(url: string): Promise<void> {
  const site = siteOf(url);
  const always = await readAlways();
  if (site !== null && covers(levelsOf(always, site), "act")) return;
  const what = site === null ? "this page (not an http(s) site)" : `site "${site}"`;
  throw new CdpError("permission_denied", `Access to ${what} is not allowed; add it in webop options to let the agent use it.`);
}

export async function isSiteAllowed(url: string): Promise<boolean> {
  try {
    await checkSite(url);
    return true;
  } catch {
    return false;
  }
}
