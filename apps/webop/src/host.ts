import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type { ExtToHost, HostToExt, HostToMcp, McpToHost } from "@webop/core/protocol";
import { encodeFrame, FrameDecoder } from "./framing.ts";
import { readLines, writeLine } from "./ndjson.ts";
import { descriptorPath, logDir, runDir, socketPath } from "./paths.ts";

const MAX_NM_MESSAGE_BYTES = 1_048_576;
const MAX_EXTEND_MS = 600_000;

type Hello = Extract<ExtToHost, { type: "hello" }>;

function isObj(m: unknown): m is Record<string, unknown> {
  return typeof m === "object" && m !== null;
}

function isDead(pid: unknown): boolean {
  if (typeof pid !== "number") return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function rmQuiet(p: string): void {
  fs.rmSync(p, { force: true });
}

export async function runHost(io: { input: Readable; output: Writable; root?: string; pid?: number }): Promise<void> {
  const { input, output, root } = io;
  const myPid = io.pid ?? process.pid;
  const logFile = path.join(logDir(root), "host.log");
  const log = (msg: string): void => {
    try {
      fs.mkdirSync(logDir(root), { recursive: true });
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);
    } catch {
      // logging must never break the host (and never touch stdout)
    }
  };
  output.on("error", (e) => log(`output error: ${e.message}`));
  const sendToExt = (msg: HostToExt): void => {
    if (!output.destroyed && output.writable) output.write(encodeFrame(msg));
  };

  const sessions = new Map<string, net.Socket>();
  const sockets = new Set<net.Socket>();
  let server: net.Server | undefined;
  let profileId: string | undefined;
  let owned = false;
  const readDescriptorPid = (id: string): unknown => {
    try {
      return JSON.parse(fs.readFileSync(descriptorPath(id, root), "utf8"))?.pid;
    } catch {
      return undefined;
    }
  };

  const sweepStale = (): void => {
    let names: string[];
    try {
      names = fs.readdirSync(runDir(root));
    } catch {
      return;
    }
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      const jp = path.join(runDir(root), n);
      try {
        const d = JSON.parse(fs.readFileSync(jp, "utf8"));
        if (!isDead(d?.pid)) continue;
      } catch {
        // unreadable descriptor: treat as stale
      }
      rmQuiet(jp);
      rmQuiet(jp.slice(0, -".json".length) + ".sock");
      log(`cleaned stale descriptor ${n}`);
    }
  };

  const onClient = (sock: net.Socket): void => {
    sockets.add(sock);
    let sessionId: string | undefined;
    sock.on("error", (e) => log(`client socket error: ${e.message}`));
    sock.on("close", () => {
      sockets.delete(sock);
      if (sessionId && sessions.get(sessionId) === sock) {
        sessions.delete(sessionId);
        sendToExt({ type: "session_close", session_id: sessionId });
      }
    });
    readLines(sock, (raw) => {
      if (!isObj(raw)) return log("dropped non-object client message");
      const m = raw as Partial<McpToHost> & Record<string, unknown>;
      if (!sessionId) {
        if (m.type !== "open") {
          log(`client first message not open (${String(m.type)}); closing`);
          sock.destroy();
          return;
        }
        const id = crypto.randomUUID();
        sessionId = id;
        sessions.set(id, sock);
        const clientName = typeof m.client_name === "string" ? m.client_name : "unknown";
        sendToExt({ type: "session_open", session_id: id, client_name: clientName });
        const opened: HostToMcp = { type: "opened", session_id: id, profile_id: hello!.profile_id, profile_label: hello!.profile_label };
        writeLine(sock, opened);
        return;
      }
      if (m.type === "call" && typeof m.id === "string" && typeof m.tool === "string") {
        const call = { type: "tool_call", id: m.id, session_id: sessionId, tool: m.tool, args: isObj(m.args) ? m.args : {} } as HostToExt;
        const frame = encodeFrame(call);
        if (frame.length - 4 > MAX_NM_MESSAGE_BYTES) {
          log(`rejected oversize tool_call ${m.id} (${frame.length - 4} bytes)`);
          writeLine(sock, { type: "result", id: m.id, error: { code: "invalid_args", message: "Tool arguments exceed the 1 MB Native Messaging limit." } });
          return;
        }
        if (!output.destroyed && output.writable) output.write(frame);
      } else if (m.type === "cancel" && typeof m.id === "string") {
        sendToExt({ type: "tool_cancel", id: m.id, session_id: sessionId });
      } else {
        log(`dropped unknown client message type ${String(m.type)}`);
      }
    });
  };

  let hello: Hello | undefined;
  const startListening = async (h: Hello): Promise<void> => {
    const id = h.profile_id;
    const prev = readDescriptorPid(id);
    if (typeof prev === "number" && prev !== myPid && !isDead(prev)) {
      log(`taking over profile ${id} from live host pid ${prev}`);
    }
    fs.mkdirSync(runDir(root), { recursive: true, mode: 0o700 });
    fs.chmodSync(runDir(root), 0o700);
    const sp = socketPath(id, root);
    rmQuiet(sp);
    const srv = net.createServer(onClient);
    await new Promise<void>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(sp, () => resolve());
    });
    server = srv;
    fs.chmodSync(sp, 0o600);
    fs.writeFileSync(
      descriptorPath(id, root),
      JSON.stringify({ profile_id: h.profile_id, profile_label: h.profile_label, pid: myPid, started_at: new Date().toISOString() }),
    );
    hello = h;
    profileId = id;
    owned = true;
    log(`listening on ${sp}`);
  };

  const onExtMessage = (raw: unknown): void => {
    if (!isObj(raw)) return log("dropped non-object ext message");
    const m = raw as Record<string, unknown>;
    if (m.type === "hello") {
      if (hello) return log("ignored duplicate hello");
      if (typeof m.profile_id !== "string" || !/^[A-Za-z0-9_-]+$/.test(m.profile_id)) return log("dropped hello with invalid profile_id");
      const h = m as unknown as Hello;
      startListening(h).catch((e) => log(`listen failed: ${(e as Error).message}`));
    } else if (m.type === "tool_result" && typeof m.session_id === "string") {
      const sock = sessions.get(m.session_id);
      if (!sock) return log(`tool_result for unknown session ${m.session_id}`);
      const { type: _t, session_id: _s, ...rest } = m;
      writeLine(sock, { type: "result", ...rest });
    } else if (m.type === "tool_pending" && typeof m.session_id === "string" && typeof m.id === "string") {
      const n = m.extend_ms;
      if (typeof n !== "number" || !Number.isInteger(n) || n <= 0 || n > MAX_EXTEND_MS) return log(`dropped tool_pending with invalid extend_ms ${String(n)}`);
      const sock = sessions.get(m.session_id);
      if (!sock) return log(`tool_pending for unknown session ${m.session_id}`);
      writeLine(sock, { type: "pending", id: m.id, extend_ms: n } satisfies HostToMcp);
    } else {
      log(`dropped unknown ext message type ${String(m.type)}`);
    }
  };

  sweepStale();

  await new Promise<void>((resolve) => {
    const dec = new FrameDecoder();
    input.on("data", (chunk: Buffer) => {
      for (const msg of dec.push(chunk)) {
        try {
          onExtMessage(msg);
        } catch (e) {
          log(`ext message handler error: ${(e as Error).message}`);
        }
      }
    });
    input.on("error", (e) => log(`input error: ${e.message}`));
    input.once("end", resolve);
    input.once("close", resolve);
  });

  for (const s of sockets) s.destroy();
  // Only remove files if the descriptor still names us; a newer host may have
  // taken over this profile. Closing a unix server unlinks its path, which
  // would delete the newer host's socket, so a displaced host just unrefs it.
  const stillOwner = owned && profileId !== undefined && readDescriptorPid(profileId) === myPid;
  if (server) {
    if (stillOwner) await new Promise<void>((r) => server!.close(() => r()));
    else server.unref();
  }
  if (stillOwner && profileId) {
    rmQuiet(socketPath(profileId, root));
    rmQuiet(descriptorPath(profileId, root));
  }
  log("input closed; host exiting");
}
