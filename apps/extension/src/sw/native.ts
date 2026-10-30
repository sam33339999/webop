import type { ExtToHost, HostToExt } from "@webop/core/protocol";
import { dispatch } from "./tools.ts";
import { closeSession, openSession } from "./sessions.ts";

const HOST = "com.webop.native_host";
const PROFILE_KEY = "webop.profile_id";

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

function post(p: chrome.runtime.Port, msg: ExtToHost): void {
  try { p.postMessage(msg); } catch { /* port already gone; onDisconnect handles it */ }
}

async function onMessage(p: chrome.runtime.Port, msg: HostToExt): Promise<void> {
  if (msg.type === "session_open") await openSession(msg.session_id, msg.client_name);
  else if (msg.type === "session_close") await closeSession(msg.session_id);
  else if (msg.type === "tool_call") {
    const { type: _t, ...call } = msg;
    post(p, { type: "tool_result", ...(await dispatch(call)) });
  }
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
    const id = await profileId();
    p = chrome.runtime.connectNative(HOST);
    port = p;
    p.onMessage.addListener((m: HostToExt) => {
      onMessage(p, m).catch((e) => console.warn("webop native message failed", e));
    });
    p.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // read so Chrome does not log "unchecked lastError"
      if (port === p) port = undefined;
      // A host that dies right after launch (not installed, crashing) must keep backing off; only a link that stayed up counts as connected.
      if (Date.now() - connectedAt >= STABLE_MS) attempts = 0;
      scheduleReconnect();
    });
    post(p, { type: "hello", profile_id: id, profile_label: `profile-${id.slice(0, 6)}`, extension_version: chrome.runtime.getManifest().version });
    connectedAt = Date.now();
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
