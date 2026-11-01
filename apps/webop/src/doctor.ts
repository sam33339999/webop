import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { HOST_NAME, manifestFile, wrapperFile } from "./install.ts";
import { readLines, writeLine } from "./ndjson.ts";
import { runDir, socketPath } from "./paths.ts";
import { VERSION } from "./version.ts";

export type Level = "ok" | "warn" | "FAIL";
export interface Check { level: Level; title: string; detail?: string }

/** Chrome always; Brave too when it is installed (it is what the user actually runs). */
export function defaultBrowserDirs(): string[] {
  const support = path.join(os.homedir(), "Library", "Application Support");
  const dirs = [path.join(support, "Google", "Chrome")];
  const brave = path.join(support, "BraveSoftware", "Brave-Browser");
  if (fs.existsSync(brave)) dirs.push(brave);
  return dirs;
}

function checkManifest(dir: string, first: boolean, extensionId: string, root?: string): Check {
  const file = manifestFile(dir);
  const title = `host manifest ${file}`;
  if (!fs.existsSync(file)) {
    // Only the first (Chrome) directory is required: Brave also reads Chrome's NativeMessagingHosts.
    return first ? { level: "FAIL", title, detail: "missing; run `webop install`" } : { level: "ok", title, detail: "not present (this browser uses Chrome's)" };
  }
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { level: "FAIL", title, detail: "not valid JSON; run `webop install` again" };
  }
  const problems: string[] = [];
  if (m.name !== HOST_NAME) problems.push(`name is ${JSON.stringify(m.name)}, expected ${HOST_NAME}`);
  if (m.path !== wrapperFile(root)) problems.push(`path is ${JSON.stringify(m.path)}, expected ${wrapperFile(root)}`);
  const origin = `chrome-extension://${extensionId}/`;
  if (!Array.isArray(m.allowed_origins) || !m.allowed_origins.includes(origin)) problems.push(`allowed_origins does not include ${origin}`);
  if (problems.length > 0) return { level: "FAIL", title, detail: `${problems.join("; ")}; run \`webop install\` again` };
  return { level: "ok", title };
}

/** The wrapper is `#!/bin/sh`, an optional `export WEBOP_ROOT=…`, then `exec '<cmd>' … native-host`. */
function checkWrapper(root?: string): Check {
  const file = wrapperFile(root);
  const title = `wrapper ${file}`;
  if (!fs.existsSync(file)) return { level: "FAIL", title, detail: "missing; run `webop install`" };
  try {
    fs.accessSync(file, fs.constants.X_OK);
  } catch {
    return { level: "FAIL", title, detail: "not executable; run `webop install` again" };
  }
  const execLine = fs.readFileSync(file, "utf8").split("\n").find((l) => l.startsWith("exec "));
  const target = execLine ? /^exec\s+'((?:[^']|'\\'')*)'/.exec(execLine)?.[1]?.replaceAll("'\\''", "'") : undefined;
  if (!execLine || !target) return { level: "FAIL", title, detail: "has no exec line; run `webop install` again" };
  if (!fs.existsSync(target)) {
    return { level: "FAIL", title, detail: `runs \`${execLine.slice(5)}\`, but ${target} does not exist; re-run \`webop install\` from the current build` };
  }
  return { level: "ok", title, detail: `runs ${execLine.slice(5)}` };
}

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

type Pong = { profile_id: string; profile_label: string; extension_version: string; webop_version: string; sessions: number };

type PingFailure = "refused" | "closed" | "timeout";

/** One ping on the profile's socket. A host older than 0.6.0 does not know ping and just closes the connection. */
function ping(sock: string, timeoutMs: number): Promise<Pong | PingFailure> {
  return new Promise((resolve) => {
    const c = net.createConnection(sock);
    let connected = false;
    let settled = false;
    const done = (v: Pong | PingFailure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      c.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => done("timeout"), timeoutMs);
    c.once("error", () => done(connected ? "closed" : "refused"));
    c.once("close", () => done(connected ? "closed" : "refused"));
    c.once("connect", () => { connected = true; writeLine(c, { type: "ping" }); });
    readLines(c, (m: any) => { if (m?.type === "pong") done(m as Pong); });
  });
}

const PING_FAILURES: Record<PingFailure, { title: string; detail: string }> = {
  refused: { title: "socket not accepting connections", detail: "the host is gone; restart the browser or reload the extension" },
  timeout: { title: "host did not answer", detail: "the host is stuck; restart the browser or reload the extension" },
  closed: { title: "host closed the connection without answering", detail: "it predates ping support (webop 0.6.0); rebuild, re-run `webop install` and reload the extension" },
};

async function checkProfiles(root: string | undefined, pingTimeoutMs: number): Promise<Check[]> {
  let names: string[] = [];
  try {
    names = fs.readdirSync(runDir(root)).filter((n) => n.endsWith(".json"));
  } catch { /* no run dir yet */ }
  const live: { id: string; label: string }[] = [];
  const stale: string[] = [];
  for (const n of names) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(runDir(root), n), "utf8"));
      if (typeof d.profile_id === "string" && pidAlive(d.pid)) live.push({ id: d.profile_id, label: String(d.profile_label ?? d.profile_id) });
      else stale.push(n);
    } catch {
      stale.push(n);
    }
  }
  const out: Check[] = [];
  if (stale.length > 0) out.push({ level: "warn", title: "stale descriptors", detail: `${stale.join(", ")} (their host is gone; the next host start cleans them up)` });
  if (live.length === 0) {
    out.push({ level: "warn", title: "no browser profile online", detail: "open the browser with the webop extension enabled (and at least one window)" });
    return out;
  }
  out.push({ level: "ok", title: `online profiles: ${live.length}` });
  for (const p of live) {
    const name = `${p.label} (${p.id})`;
    const pong = await ping(socketPath(p.id, root), pingTimeoutMs);
    if (typeof pong === "string") {
      out.push({ level: "FAIL", title: `${name}: ${PING_FAILURES[pong].title}`, detail: PING_FAILURES[pong].detail });
      continue;
    }
    const summary = `${pong.profile_label} (${pong.profile_id}): extension ${pong.extension_version}, ${pong.sessions} session(s)`;
    if (pong.extension_version !== pong.webop_version || pong.webop_version !== VERSION) {
      out.push({
        level: "warn",
        title: summary,
        detail: `version mismatch: webop ${VERSION}, host ${pong.webop_version}, extension ${pong.extension_version}; rebuild, re-run \`webop install\` and reload the extension`,
      });
    } else {
      out.push({ level: "ok", title: summary });
    }
  }
  return out;
}

export async function doctor(o: { root?: string; browserDirs?: string[]; extensionId: string; pingTimeoutMs?: number }): Promise<Check[]> {
  const dirs = o.browserDirs ?? defaultBrowserDirs();
  return [
    ...dirs.map((d, i) => checkManifest(d, i === 0, o.extensionId, o.root)),
    checkWrapper(o.root),
    ...(await checkProfiles(o.root, o.pingTimeoutMs ?? 2000)),
  ];
}

export function formatChecks(checks: Check[]): string {
  return checks.map((c) => `${c.level} ${c.title}${c.detail ? `\n  ${c.detail}` : ""}`).join("\n");
}
