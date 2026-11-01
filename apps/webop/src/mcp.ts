import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ContentBlock, ErrorCode, McpToHost, ToolName } from "@webop/core/protocol";
import { readLines, writeLine } from "./ndjson.ts";
import { logDir, runDir, socketPath } from "./paths.ts";
import { TOOL_DEFS } from "./tool-schemas.ts";
import type { Budget } from "@webop/core/budget";
import { VERSION } from "./version.ts";

const MAX_EXTEND_MS = 600_000;

type Outcome = { content: ContentBlock[] } | { error: { code: ErrorCode; message: string } };
const fail = (code: ErrorCode, message: string): Outcome => ({ error: { code, message } });

interface Conn {
  sock: net.Socket;
  profile_id: string;
  pending: Map<string, (o: Outcome) => void>;
  /** Restarts a pending call's timer with a longer allowance (the extension is waiting on the user). */
  extend: Map<string, (ms: number) => void>;
}

function logLine(m: string): void {
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    fs.appendFileSync(path.join(logDir(), "mcp.log"), `${new Date().toISOString()} ${m}\n`);
  } catch {
    // logging must never break stdio
  }
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

function liveProfiles(root?: string): { profile_id: string; profile_label: string }[] {
  let names: string[];
  try {
    names = fs.readdirSync(runDir(root)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: { profile_id: string; profile_label: string }[] = [];
  for (const n of names) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(runDir(root), n), "utf8"));
      if (typeof d.profile_id === "string" && pidAlive(d.pid)) {
        out.push({ profile_id: d.profile_id, profile_label: String(d.profile_label ?? d.profile_id) });
      }
    } catch {
      // unreadable descriptor: ignore
    }
  }
  return out;
}

export function createMcpServer(opts: { root?: string; callTimeoutMs?: number; profile?: string; budget?: Budget }): McpServer {
  const root = opts.root;
  const callTimeoutMs = opts.callTimeoutMs ?? 60_000;
  const pinned = opts.profile;
  const server = new McpServer({ name: "webop", version: VERSION });
  let conn: Conn | null = null;
  let connecting: Promise<Conn | Outcome> | null = null;
  let nextId = 1;
  /** Which online profile may be used. `none` means "whatever single profile is online". */
  let binding: { kind: "none" } | { kind: "explicit"; profile_id: string; profile_label: string } = { kind: "none" };
  let profileCache: { at: number; list: { profile_id: string; profile_label: string }[] } | null = null;

  /** Re-reads the run directory at most every 500 ms: a new profile should be noticed quickly, a vanished one soon after. */
  function onlineProfiles(): { profile_id: string; profile_label: string }[] {
    const now = Date.now();
    if (!profileCache || now - profileCache.at > 500) {
      const list = liveProfiles(root);
      // An empty result is not cached: the first profile usually shows up right after the browser starts.
      profileCache = list.length > 0 ? { at: now, list } : null;
      return list;
    }
    return profileCache.list;
  }

  const describe = (list: { profile_id: string; profile_label: string }[]): string =>
    list.map((p) => `${p.profile_label} (${p.profile_id})`).join(", ");

  /** Exact id first, then a case-insensitive exact label. */
  const matchProfiles = (wanted: string, profiles: { profile_id: string; profile_label: string }[]) => {
    const byId = profiles.filter((p) => p.profile_id === wanted);
    return byId.length > 0 ? byId : profiles.filter((p) => p.profile_label.toLowerCase() === wanted.toLowerCase());
  };

  function dropConn(c: Conn): void {
    if (conn === c) conn = null;
    const pend = [...c.pending.values()];
    c.pending.clear();
    c.extend.clear();
    for (const f of pend) f(fail("not_connected", "Connection to webop host was lost"));
  }

  /** Drops the host connection (the host then closes its session; its tabs stay open). */
  function closeConn(): void {
    const c = conn;
    if (!c) return;
    dropConn(c);
    c.sock.destroy();
  }

  async function establish(profile: { profile_id: string; profile_label: string }): Promise<Conn | Outcome> {
    const sock = net.createConnection(socketPath(profile.profile_id, root));
    const c: Conn = { sock, profile_id: profile.profile_id, pending: new Map(), extend: new Map() };
    return new Promise<Conn | Outcome>((resolve) => {
      let opened = false;
      const unavailable = (m: string) => resolve(fail("not_connected", m));
      sock.once("error", (e) => {
        if (!opened) unavailable(`Cannot connect to webop host: ${(e as NodeJS.ErrnoException).code ?? e.message}`);
      });
      sock.once("close", () => {
        if (!opened) unavailable("webop host closed the connection");
        else dropConn(c);
      });
      readLines(sock, (m) => {
        try {
          handleMessage(m);
        } catch (e) {
          logLine(`host message handler error ${e}`);
        }
      });
      const handleMessage = (m: unknown): void => {
        if (typeof m !== "object" || m === null || Array.isArray(m)) {
          logLine(`ignored non-object host message: ${JSON.stringify(m)}`);
          return;
        }
        const msg = m as Record<string, unknown>;
        if (msg.type === "opened") {
          opened = true;
          conn = c;
          resolve(c);
        } else if (msg.type === "result") {
          if (typeof msg.id !== "string") {
            logLine("ignored result without string id");
            return;
          }
          const f = c.pending.get(msg.id);
          if (!f) return;
          c.pending.delete(msg.id);
          c.extend.delete(msg.id);
          const err = msg.error as Record<string, unknown> | null | undefined;
          if (Array.isArray(msg.content)) {
            f({ content: msg.content as ContentBlock[] });
          } else if (typeof err === "object" && err !== null && typeof err.code === "string" && typeof err.message === "string") {
            f({ error: { code: err.code as ErrorCode, message: err.message } });
          } else {
            f(fail("internal", "malformed host response"));
          }
        } else if (msg.type === "pending") {
          const n = msg.extend_ms;
          if (typeof msg.id !== "string" || typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
            logLine("ignored malformed pending");
            return;
          }
          c.extend.get(msg.id)?.(n);
        }
      };
      sock.once("connect", () => {
        const name = server.server.getClientVersion()?.name ?? "unknown";
        writeLine(sock, { type: "open", client_name: name, ...(opts.budget ? { budget: opts.budget } : {}) } satisfies McpToHost);
      });
      const t = setTimeout(() => {
        if (!opened) {
          sock.destroy();
          unavailable("Timed out opening a session with the webop host");
        }
      }, callTimeoutMs);
      t.unref();
    });
  }

  async function getConn(): Promise<Conn | Outcome> {
    const profiles = onlineProfiles();
    if (binding.kind === "none" && pinned !== undefined) {
      // `--profile` pins on first use; it is re-tried every call so start-up order does not matter.
      const matches = matchProfiles(pinned, profiles);
      if (matches.length === 0) {
        return fail("not_connected", `Profile "${pinned}" is not online. Online: ${describe(profiles) || "none"}.`);
      }
      if (matches.length > 1) return fail("profile_required", `"${pinned}" matches several profiles: ${describe(matches)}. Use a profile_id.`);
      binding = { kind: "explicit", profile_id: matches[0]!.profile_id, profile_label: matches[0]!.profile_label };
    }
    if (binding.kind === "explicit") {
      const target = profiles.find((p) => p.profile_id === (binding as { profile_id: string }).profile_id);
      if (!target) {
        closeConn();
        return fail("not_connected", `Profile "${(binding as { profile_label: string }).profile_label}" is not online. Online: ${describe(profiles) || "none"}.`);
      }
      if (conn && conn.profile_id === target.profile_id) return conn;
      closeConn();
      if (!connecting) connecting = establish(target).finally(() => { connecting = null; });
      return connecting;
    }
    if (profiles.length === 0) {
      closeConn();
      return fail("not_connected", "No webop browser profile is online. Open the browser with the webop extension enabled.");
    }
    if (profiles.length > 1) {
      // Keep the current connection but serve nothing: the caller must say which profile it means.
      return fail(
        "profile_required",
        `Multiple browser profiles are online: ${describe(profiles)}. Call browser_profile_select to pick one for this session.`,
      );
    }
    const only = profiles[0]!;
    if (conn && conn.profile_id === only.profile_id) return conn;
    closeConn();
    if (!connecting) connecting = establish(only).finally(() => { connecting = null; });
    return connecting;
  }

  async function selectProfile(profile: string): Promise<Outcome> {
    const wanted = profile.trim();
    if (wanted === "") return fail("invalid_args", "profile must be a non-empty profile_id or profile label.");
    const profiles = onlineProfiles();
    const matches = matchProfiles(wanted, profiles);
    if (matches.length === 0) return fail("not_connected", `No online profile matches "${wanted}". Online: ${describe(profiles) || "none"}.`);
    if (matches.length > 1) return fail("profile_required", `"${wanted}" matches several profiles: ${describe(matches)}. Pass a profile_id instead.`);
    const chosen = matches[0]!;
    binding = { kind: "explicit", profile_id: chosen.profile_id, profile_label: chosen.profile_label };
    if (conn && conn.profile_id !== chosen.profile_id) closeConn();
    return { content: [{ type: "text", text: `Selected ${chosen.profile_label} (${chosen.profile_id}).` }] };
  }

  function listProfiles(): Outcome {
    const profiles = onlineProfiles();
    const selectedId = binding.kind === "explicit" ? binding.profile_id : conn?.profile_id;
    return {
      content: [{
        type: "text",
        text: JSON.stringify(profiles.map((p) => ({ ...p, selected: p.profile_id === selectedId }))),
      }],
    };
  }

  async function forward(tool: ToolName, args: Record<string, unknown>, signal?: AbortSignal): Promise<Outcome> {
    if (signal?.aborted) return fail("internal", "Tool call was cancelled by the client");
    const c = await getConn();
    if (!("sock" in c)) return c;
    if (signal?.aborted) return fail("internal", "Tool call was cancelled by the client");
    const id = String(nextId++);
    return new Promise<Outcome>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = (): void => {
        clearTimeout(timer);
        c.pending.delete(id);
        c.extend.delete(id);
        signal?.removeEventListener("abort", onAbort);
      };
      const giveUp = (o: Outcome): void => {
        cleanup();
        writeLine(c.sock, { type: "cancel", id } satisfies McpToHost);
        resolve(o);
      };
      const startedAt = Date.now();
      const arm = (ms: number): void => {
        clearTimeout(timer);
        timer = setTimeout(() => giveUp(fail("timeout", `Tool call timed out after ${Date.now() - startedAt} ms`)), ms);
      };
      const onAbort = (): void => giveUp(fail("internal", "Tool call was cancelled by the client"));
      arm(callTimeoutMs);
      c.pending.set(id, (o) => {
        cleanup();
        resolve(o);
      });
      c.extend.set(id, (ms) => arm(Math.min(ms, MAX_EXTEND_MS) + callTimeoutMs));
      signal?.addEventListener("abort", onAbort, { once: true });
      writeLine(c.sock, { type: "call", id, tool, args } satisfies McpToHost);
    });
  }

  for (const def of TOOL_DEFS) {
    server.registerTool(def.name, { description: def.description, inputSchema: def.shape }, async (args, extra) => {
      let o: Outcome;
      if (def.tool === "profiles_list") {
        o = listProfiles();
      } else if (def.tool === "profile_select") {
        const profile = (args as { profile?: unknown }).profile;
        o = typeof profile === "string" ? await selectProfile(profile) : fail("invalid_args", "profile must be a string.");
      } else {
        o = await forward(def.tool, args as Record<string, unknown>, extra.signal);
      }
      if ("error" in o) {
        return { isError: true, content: [{ type: "text", text: `${o.error.code}: ${o.error.message}` }] };
      }
      return { content: o.content } satisfies CallToolResult;
    });
  }
  return server;
}

export async function runMcp(o: { profile?: string; budget?: Budget } = {}): Promise<void> {
  const server = createMcpServer(o);
  const log = logLine;
  process.on("uncaughtException", (e) => log(`uncaughtException ${e.stack ?? e}`));
  process.on("unhandledRejection", (e) => log(`unhandledRejection ${e}`));
  await server.connect(new StdioServerTransport());
  log(`mcp server started (webop ${VERSION})`);
  await new Promise<void>((resolve) => {
    process.stdin.once("close", resolve);
    process.stdin.once("end", resolve);
  });
}
