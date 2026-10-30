import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type { ExtToHost, HostToExt, HostToMcp, McpToHost } from "@webop/core/protocol";
import { encodeFrame, FrameDecoder } from "./framing.ts";
import { readLines, writeLine } from "./ndjson.ts";
import { descriptorPath, logDir, runDir, socketPath } from "./paths.ts";

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
        sendToExt({ type: "tool_call", id: m.id, session_id: sessionId, tool: m.tool, args: isObj(m.args) ? m.args : {} } as HostToExt);
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
