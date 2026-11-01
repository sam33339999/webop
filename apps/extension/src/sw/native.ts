import type { ExtToHost, HostToExt } from "@webop/core/protocol";
import { dispatch } from "./tools.ts";
import { cancelCall, setPendingSink } from "./callctx.ts";
import { closeHostSessions, closeSession, openSession } from "./sessions.ts";

const HOST = "com.webop.native_host";
const PROFILE_KEY = "webop.profile_id";
const LABEL_KEY = "webop.profile_label";

const STABLE_MS = 5000;
let port: chrome.runtime.Port | undefined;
let attempts = 0;
let connectedAt = 0;
let connecting = false;
let retry: ReturnType<typeof setTimeout> | undefined;

async function profileId(): Promise<string> {
  const saved = (await chrome.storage.local.get(PROFILE_KEY))[PROFILE_KEY];
  if (typeof saved === "string" && saved) return saved;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [PROFILE_KEY]: id });
  return id;
}

/** What agents see for this profile: the name set in options, else the signed-in email, else `profile-<id prefix>`. */
export async function profileLabel(id: string): Promise<string> {
  const saved = (await chrome.storage.local.get(LABEL_KEY))[LABEL_KEY];
  if (typeof saved === "string" && saved.trim()) return saved.trim().slice(0, 64);
  try {
    const info = await chrome.identity.getProfileUserInfo({ accountStatus: chrome.identity.AccountStatus.ANY });
    if (info.email) return info.email;
  } catch {
    // identity unavailable (e.g. not signed in, or the API is missing): fall back to the id
  }
  return `profile-${id.slice(0, 6)}`;
}

// A rename in options reaches the host right away, so `browser_profiles_list` shows it without a restart.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !(LABEL_KEY in changes)) return;
  const p = port;
  if (!p) return;
  void profileId().then(profileLabel).then((profile_label) => { if (port === p) post(p, { type: "profile_label", profile_label }); });
});

function post(p: chrome.runtime.Port, msg: ExtToHost): void {
  try { p.postMessage(msg); } catch { /* port already gone; onDisconnect handles it */ }
}

async function onMessage(p: chrome.runtime.Port, msg: HostToExt): Promise<void> {
  if (msg.type === "session_open") await openSession(msg.session_id, msg.client_name, msg.budget);
  else if (msg.type === "session_close") await closeSession(msg.session_id);
  else if (msg.type === "tool_cancel") cancelCall(msg.session_id, msg.id);
  else if (msg.type === "tool_call") {
    const { type: _t, ...call } = msg;
    post(p, { type: "tool_result", ...(await dispatch(call)) });
  }
}

setPendingSink((m) => { if (port) post(port, m); });

/**
 * A profile with no normal window is closed as far as the user is concerned (Chrome may keep running, e.g. on macOS or
 * for another profile). The link is dropped then and only re-made when a window opens; otherwise the SW, kept alive by
 * the port, would keep a host and its descriptor around and agents would see a "ghost" profile.
 * The permission prompt is a popup window and does not count.
 */
let waitingForWindow = false;

/** Dev-only seam: e2e browsers quit with their last window, so tests substitute the window count. */
export const nativeDevHooks: { normalWindows?: () => Promise<number> } = {};

async function hasNormalWindow(): Promise<boolean> {
  if (__DEV__ && nativeDevHooks.normalWindows) return (await nativeDevHooks.normalWindows()) > 0;
  try {
    return (await chrome.windows.getAll({ windowTypes: ["normal"] })).length > 0;
  } catch {
    return true; // when unsure, behave as before (stay connected)
  }
}

/** Drops the link because the profile has no window left; reconnects only from `onWindowOpened`. */
async function goOffline(): Promise<void> {
  waitingForWindow = true;
  clearTimeout(retry);
  const p = port;
  if (!p) return;
  port = undefined;
  // disconnect() does not fire our own onDisconnect, so release the sessions here; the host sees stdin close and exits.
  try { p.disconnect(); } catch { /* already gone */ }
  await closeHostSessions().catch((e) => console.warn("webop closing host sessions failed", e));
}

/** Re-checked after a window closes: the last normal window going away takes the profile offline. */
export async function onWindowClosed(): Promise<void> {
  if (!(await hasNormalWindow())) await goOffline();
}

/** A window opened: a profile that went offline for lack of windows connects again right away. */
export async function onWindowOpened(): Promise<void> {
  if (!waitingForWindow || !(await hasNormalWindow())) return;
  waitingForWindow = false;
  attempts = 0;
  clearTimeout(retry);
  await connect();
}

chrome.windows.onRemoved.addListener(() => { void onWindowClosed(); });
chrome.windows.onCreated.addListener((w) => { if (w.type === undefined || w.type === "normal") void onWindowOpened(); });

/** Dev-only: whether the link is up, and whether it is parked waiting for a window. */
export function linkState(): { connected: boolean; waitingForWindow: boolean } {
  return { connected: !!port, waitingForWindow };
}

function scheduleReconnect(): void {
  attempts++;
  const delay = Math.min(1000 * 2 ** (attempts - 1), 30000);
  clearTimeout(retry);
  retry = setTimeout(() => void connect(), delay);
}

async function connect(): Promise<void> {
  if (port || connecting) return;
  connecting = true;
  let p: chrome.runtime.Port;
  try {
    // Any wake-up (SW start, backoff timer, options page) with no window open must not bring a host up.
    if (!(await hasNormalWindow())) {
      waitingForWindow = true;
      return;
    }
    const id = await profileId();
    const label = await profileLabel(id);
    // Sessions that outlived their host connection (e.g. the SW was restarted) are stale.
    await closeHostSessions();
    p = chrome.runtime.connectNative(HOST);
    port = p;
    p.onMessage.addListener((m: HostToExt) => {
      onMessage(p, m).catch((e) => console.warn("webop native message failed", e));
    });
    p.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // read so Chrome does not log "unchecked lastError"
      if (port === p) port = undefined;
      // Sessions are per host connection: nobody can drive or close them any more, so release the tabs.
      closeHostSessions().catch((e) => console.warn("webop closing host sessions failed", e));
      // A host that dies right after launch (not installed, crashing) must keep backing off; only a link that stayed up counts as connected.
      if (Date.now() - connectedAt >= STABLE_MS) attempts = 0;
      // Without a window the profile stays offline until one opens (onWindowOpened), instead of respawning a host.
      void hasNormalWindow().then((has) => { if (has) scheduleReconnect(); else waitingForWindow = true; });
    });
    post(p, { type: "hello", profile_id: id, profile_label: label, extension_version: chrome.runtime.getManifest().version });
    // A rename between reading the label and `port` being set was not sent by onChanged (no port yet); catch it up.
    void profileLabel(id).then((now) => { if (now !== label && port === p) post(p, { type: "profile_label", profile_label: now }); });
    connectedAt = Date.now();
    // The last window may have closed while we were connecting (before onWindowClosed could see the port).
    void hasNormalWindow().then((has) => { if (!has && port === p) void goOffline(); });
  } catch {
    port = undefined;
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

/** Idempotent; safe to call from SW top level, onStartup and onInstalled. */
export function startNativeLink(): void {
  void connect();
}

/** Connects now, discarding any pending backoff (used when the options page is opened after a late `webop install`). */
export function wakeNativeLink(): void {
  if (port) return;
  waitingForWindow = false;
  attempts = 0;
  clearTimeout(retry);
  void connect();
}
