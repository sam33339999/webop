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

const MAX_EXTEND_MS = 600_000;

type Outcome = { content: ContentBlock[] } | { error: { code: ErrorCode; message: string } };
const fail = (code: ErrorCode, message: string): Outcome => ({ error: { code, message } });

interface Conn {
  sock: net.Socket;
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

export function createMcpServer(opts: { root?: string; callTimeoutMs?: number }): McpServer {
  const root = opts.root;
  const callTimeoutMs = opts.callTimeoutMs ?? 60_000;
  const server = new McpServer({ name: "webop", version: "0.0.0" });
  let conn: Conn | null = null;
  let connecting: Promise<Conn | Outcome> | null = null;
  let nextId = 1;

  function dropConn(c: Conn): void {
    if (conn === c) conn = null;
    const pend = [...c.pending.values()];
    c.pending.clear();
    c.extend.clear();
    for (const f of pend) f(fail("not_connected", "Connection to webop host was lost"));
  }

  async function establish(): Promise<Conn | Outcome> {
    const profiles = liveProfiles(root);
    if (profiles.length === 0) {
      return fail("not_connected", "No webop browser profile is online. Open the browser with the webop extension enabled.");
    }
    if (profiles.length > 1) {
      return fail(
        "profile_required",
        `Multiple browser profiles are online: ${profiles.map((p) => p.profile_label).join(", ")}. Only one can be used at a time.`,
      );
    }
    const sock = net.createConnection(socketPath(profiles[0]!.profile_id, root));
    const c: Conn = { sock, pending: new Map(), extend: new Map() };
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
        writeLine(sock, { type: "open", client_name: name } satisfies McpToHost);
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
    if (conn) return conn;
    connecting ??= establish().finally(() => {
      connecting = null;
    });
    return connecting;
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
      const o = await forward(def.tool, args as Record<string, unknown>, extra.signal);
      if ("error" in o) {
        return { isError: true, content: [{ type: "text", text: `${o.error.code}: ${o.error.message}` }] };
      }
      return { content: o.content } satisfies CallToolResult;
    });
  }
  return server;
}

export async function runMcp(): Promise<void> {
  const server = createMcpServer({});
  const log = logLine;
  process.on("uncaughtException", (e) => log(`uncaughtException ${e.stack ?? e}`));
  process.on("unhandledRejection", (e) => log(`unhandledRejection ${e}`));
  await server.connect(new StdioServerTransport());
  log("mcp server started");
  await new Promise<void>((resolve) => {
    process.stdin.once("close", resolve);
    process.stdin.once("end", resolve);
  });
}
