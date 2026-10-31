import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runHost } from "../src/host.ts";
import { encodeFrame, FrameDecoder } from "../src/framing.ts";
import { readLines, writeLine } from "../src/ndjson.ts";
import { descriptorPath, runDir, socketPath } from "../src/paths.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error("timeout"); await sleep(10); }
};

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wh-"));
  const input = new PassThrough();
  const output = new PassThrough();
  const fromHost: any[] = [];
  const dec = new FrameDecoder();
  output.on("data", (c: Buffer) => fromHost.push(...dec.push(c)));
  const done = runHost({ input, output, root });
  const hello = { type: "hello", profile_id: "p1", profile_label: "Work", extension_version: "0.0.1" };
  const sendHello = () => input.write(encodeFrame(hello));
  const sock = socketPath("p1", root);
  const connect = async () => {
    const c = net.createConnection(sock);
    await new Promise((r) => c.once("connect", r));
    const msgs: any[] = [];
    readLines(c, (m) => msgs.push(m));
    return { c, msgs };
  };
  return { root, input, output, fromHost, done, sendHello, sock, connect };
}

test("no listen before hello", async () => {
  const t = setup();
  await sleep(100);
  assert.equal(fs.existsSync(t.sock), false);
  t.input.end(); await t.done;
});

test("hello → socket 0600 and descriptor written", async () => {
  const t = setup();
  t.sendHello();
  await until(() => fs.existsSync(t.sock));
  await until(() => fs.existsSync(descriptorPath("p1", t.root)));
  assert.equal(fs.statSync(t.sock).mode & 0o777, 0o600);
  assert.equal(fs.statSync(runDir(t.root)).mode & 0o777, 0o700);
  const d = JSON.parse(fs.readFileSync(descriptorPath("p1", t.root), "utf8"));
  assert.equal(d.profile_id, "p1");
  assert.equal(d.profile_label, "Work");
  assert.equal(d.pid, process.pid);
  assert.equal(typeof d.started_at, "string");
  t.input.end(); await t.done;
});

test("stale socket and dead-pid descriptor cleaned", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wh-"));
  fs.mkdirSync(runDir(root), { recursive: true, mode: 0o700 });
  // dead pid: spawn-and-reap a short child to get a surely-dead pid
  const { spawnSync } = await import("node:child_process");
  const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
  fs.writeFileSync(descriptorPath("dead", root), JSON.stringify({ profile_id: "dead", pid: dead }));
  fs.writeFileSync(socketPath("dead", root), "");
  fs.writeFileSync(descriptorPath("alive", root), JSON.stringify({ profile_id: "alive", pid: process.pid }));
  fs.writeFileSync(socketPath("alive", root), "");
  // stale socket with same name as ours
  fs.writeFileSync(socketPath("p1", root), "stale");
  const input = new PassThrough();
  const output = new PassThrough();
  const done = runHost({ input, output, root });
  await until(() => !fs.existsSync(descriptorPath("dead", root)));
  assert.equal(fs.existsSync(socketPath("dead", root)), false);
  assert.equal(fs.existsSync(descriptorPath("alive", root)), true);
  input.write(encodeFrame({ type: "hello", profile_id: "p1", profile_label: "L", extension_version: "1" }));
  await until(() => fs.existsSync(descriptorPath("p1", root)));
  assert.equal(fs.statSync(socketPath("p1", root)).isSocket(), true);
  input.end(); await done;
});

test("open → session_open sent to ext → opened returned", async () => {
  const t = setup();
  t.sendHello();
  await until(() => fs.existsSync(descriptorPath("p1", t.root)));
  const a = await t.connect();
  writeLine(a.c, { type: "open", client_name: "claude" });
  await until(() => a.msgs.length === 1);
  assert.equal(a.msgs[0].type, "opened");
  assert.equal(a.msgs[0].profile_id, "p1");
  assert.equal(a.msgs[0].profile_label, "Work");
  const sid = a.msgs[0].session_id;
  assert.match(sid, /^[0-9a-f-]{36}$/);
  await until(() => t.fromHost.length === 1);
  assert.deepEqual(t.fromHost[0], { type: "session_open", session_id: sid, client_name: "claude" });
  a.c.destroy(); t.input.end(); await t.done;
});

test("call routed with session_id; result routed back to the right client", async () => {
  const t = setup();
  t.sendHello();
  await until(() => fs.existsSync(descriptorPath("p1", t.root)));
  const a = await t.connect();
  const b = await t.connect();
  writeLine(a.c, { type: "open", client_name: "A" });
  writeLine(b.c, { type: "open", client_name: "B" });
  await until(() => a.msgs.length === 1 && b.msgs.length === 1);
  writeLine(a.c, { type: "call", id: "1", tool: "tabs_list", args: {} });
  writeLine(b.c, { type: "call", id: "2", tool: "tabs_list", args: { x: 1 } });
  await until(() => t.fromHost.filter((m) => m.type === "tool_call").length === 2);
  const calls = t.fromHost.filter((m) => m.type === "tool_call");
  const ca = calls.find((m) => m.id === "1");
  const cb = calls.find((m) => m.id === "2");
  assert.equal(ca.session_id, a.msgs[0].session_id);
  assert.equal(cb.session_id, b.msgs[0].session_id);
  // answer b first, then a
  t.input.write(encodeFrame({ type: "tool_result", id: "2", session_id: cb.session_id, content: [{ type: "text", text: "B" }] }));
  t.input.write(encodeFrame({ type: "tool_result", id: "1", session_id: ca.session_id, error: { code: "timeout", message: "m" } }));
  await until(() => a.msgs.length === 2 && b.msgs.length === 2);
  assert.deepEqual(b.msgs[1], { type: "result", id: "2", content: [{ type: "text", text: "B" }] });
  assert.deepEqual(a.msgs[1], { type: "result", id: "1", error: { code: "timeout", message: "m" } });
  a.c.destroy(); b.c.destroy(); t.input.end(); await t.done;
});

test("client disconnect → session_close", async () => {
  const t = setup();
  t.sendHello();
  await until(() => fs.existsSync(descriptorPath("p1", t.root)));
  const a = await t.connect();
  writeLine(a.c, { type: "open", client_name: "A" });
  await until(() => a.msgs.length === 1);
  a.c.destroy();
  await until(() => t.fromHost.some((m) => m.type === "session_close"));
  assert.equal(t.fromHost.find((m) => m.type === "session_close").session_id, a.msgs[0].session_id);
  t.input.end(); await t.done;
});

test("first message not open closes client; garbage does not crash host", async () => {
  const t = setup();
  t.input.write(encodeFrame({ nonsense: true }));
  t.input.write(Buffer.from([2, 0, 0, 0, 0x7b, 0x7b])); // malformed JSON frame
  t.sendHello();
  await until(() => fs.existsSync(descriptorPath("p1", t.root)));
  const a = await t.connect();
  const closed = new Promise((r) => a.c.once("close", r));
  writeLine(a.c, { type: "call", id: "1", tool: "tabs_list", args: {} });
  await closed;
  const b = await t.connect();
  writeLine(b.c, { type: "open", client_name: "B" });
  await until(() => b.msgs.length === 1);
  t.input.write(encodeFrame({ type: "tool_result", id: "x", session_id: "nope", content: [] }));
  await sleep(50);
  assert.equal(b.msgs.length, 1);
  b.c.destroy(); t.input.end(); await t.done;
});

test("stdin end → socket and descriptor removed", async () => {
  const t = setup();
  t.sendHello();
  await until(() => fs.existsSync(descriptorPath("p1", t.root)));
  const a = await t.connect();
  const closed = new Promise((r) => a.c.once("close", r));
  t.input.end();
  await t.done;
  await closed;
  assert.equal(fs.existsSync(t.sock), false);
  assert.equal(fs.existsSync(descriptorPath("p1", t.root)), false);
});

test("replaced host: old host exit leaves new host's socket and descriptor", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wh-"));
  const hello = encodeFrame({ type: "hello", profile_id: "p", profile_label: "L", extension_version: "1" });
  const mk = (pid: number) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const sent: any[] = [];
    const dec = new FrameDecoder();
    output.on("data", (c: Buffer) => sent.push(...dec.push(c)));
    return { input, sent, done: runHost({ input, output, root, pid }) };
  };
  const a = mk(process.ppid); // a live pid that is not ours
  a.input.write(hello);
  await until(() => fs.existsSync(descriptorPath("p", root)));
  const b = mk(process.pid);
  b.input.write(hello);
  await until(() => JSON.parse(fs.readFileSync(descriptorPath("p", root), "utf8")).pid === process.pid);
  a.input.end();
  await a.done;
  assert.equal(fs.existsSync(descriptorPath("p", root)), true);
  assert.equal(fs.existsSync(socketPath("p", root)), true);
  const c = net.createConnection(socketPath("p", root));
  await new Promise((r) => c.once("connect", r));
  const msgs: any[] = [];
  readLines(c, (m) => msgs.push(m));
  writeLine(c, { type: "open", client_name: "x" });
  await until(() => msgs.length === 1 && b.sent.length === 1);
  assert.equal(b.sent[0].type, "session_open");
  c.destroy(); b.input.end(); await b.done;
  assert.equal(fs.existsSync(descriptorPath("p", root)), false);
});

test("exit with descriptor pid not ours leaves files untouched", async () => {
  const t = setup();
  t.sendHello();
  await until(() => fs.existsSync(descriptorPath("p1", t.root)));
  fs.writeFileSync(descriptorPath("p1", t.root), JSON.stringify({ profile_id: "p1", pid: process.ppid }));
  t.input.end(); await t.done;
  assert.equal(fs.existsSync(descriptorPath("p1", t.root)), true);
});
