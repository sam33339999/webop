import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.ts";
import { readLines, writeLine } from "../src/ndjson.ts";
import { descriptorPath, runDir, socketPath } from "../src/paths.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wm-"));
  fs.mkdirSync(runDir(root), { recursive: true });
  return root;
}
function descriptor(root: string, id: string, label: string, pid = process.pid) {
  fs.writeFileSync(
    descriptorPath(id, root),
    JSON.stringify({ profile_id: id, profile_label: label, pid, started_at: new Date().toISOString() }),
  );
}
type Handler = (m: any, sock: net.Socket) => void;
async function fakeHost(root: string, id: string, label: string, onCall: Handler) {
  descriptor(root, id, label);
  const seen: any[] = [];
  const socks: net.Socket[] = [];
  const srv = net.createServer((s) => {
    socks.push(s);
    readLines(s, (m: any) => {
      seen.push(m);
      if (m.type === "open") {
        writeLine(s, { type: "opened", session_id: "s1", profile_id: id, profile_label: label });
      } else onCall(m, s);
    });
  });
  await new Promise<void>((r) => srv.listen(socketPath(id, root), r));
  return { seen, socks, close: () => { socks.forEach((s) => s.destroy()); srv.close(); } };
}
async function connectClient(opts: { root: string; callTimeoutMs?: number }) {
  const server = createMcpServer(opts);
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const text = (r: any) => r.content[0].text as string;

test("lists six browser_ tools", async () => {
  const client = await connectClient({ root: tmpRoot() });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "browser_computer", "browser_navigate", "browser_read_page",
    "browser_tabs_close", "browser_tabs_create", "browser_tabs_list",
  ]);
});

test("no host → isError not_connected, server stays up, then succeeds once host appears", async () => {
  const root = tmpRoot();
  const client = await connectClient({ root });
  const r1: any = await client.callTool({ name: "browser_tabs_list", arguments: {} });
  assert.equal(r1.isError, true);
  assert.match(text(r1), /^not_connected:/);
  const host = await fakeHost(root, "p1", "Work", (m, s) =>
    writeLine(s, { type: "result", id: m.id, content: [{ type: "text", text: "ok" }] }));
  const r2: any = await client.callTool({ name: "browser_tabs_list", arguments: {} });
  assert.equal(r2.isError, undefined);
  assert.equal(text(r2), "ok");
  host.close();
});

test("stale descriptor (dead pid) is ignored", async () => {
  const root = tmpRoot();
  descriptor(root, "dead", "Dead", 2 ** 22 + 12345);
  const host = await fakeHost(root, "p1", "Work", (m, s) =>
    writeLine(s, { type: "result", id: m.id, content: [{ type: "text", text: "ok" }] }));
  const client = await connectClient({ root });
  const r: any = await client.callTool({ name: "browser_tabs_list", arguments: {} });
  assert.equal(text(r), "ok");
  host.close();
});

test("two descriptors → profile_required listing both labels", async () => {
  const root = tmpRoot();
  descriptor(root, "a", "Work");
  descriptor(root, "b", "Personal");
  const client = await connectClient({ root });
  const r: any = await client.callTool({ name: "browser_tabs_list", arguments: {} });
  assert.equal(r.isError, true);
  assert.match(text(r), /^profile_required:/);
  assert.match(text(r), /Work/);
  assert.match(text(r), /Personal/);
});

test("call forwarded with stripped prefix; image content passed through", async () => {
  const root = tmpRoot();
  const host = await fakeHost(root, "p1", "Work", (m, s) =>
    writeLine(s, {
      type: "result", id: m.id,
      content: [{ type: "image", data: "QUJD", mimeType: "image/jpeg" }, { type: "text", text: "shot" }],
    }));
  const client = await connectClient({ root });
  const r: any = await client.callTool({
    name: "browser_computer", arguments: { action: "screenshot", tab_id: 7 },
  });
  assert.deepEqual(r.content[0], { type: "image", data: "QUJD", mimeType: "image/jpeg" });
  assert.equal(r.content[1].text, "shot");
  assert.deepEqual(host.seen[0], { type: "open", client_name: "test-agent" });
  const call = host.seen[1];
  assert.equal(call.type, "call");
  assert.equal(call.tool, "computer");
  assert.deepEqual(call.args, { action: "screenshot", tab_id: 7 });
  host.close();
});

test("host error → isError with code prefix", async () => {
  const root = tmpRoot();
  const host = await fakeHost(root, "p1", "Work", (m, s) =>
    writeLine(s, { type: "result", id: m.id, error: { code: "permission_denied", message: "nope.com not allowed" } }));
  const client = await connectClient({ root });
  const r: any = await client.callTool({ name: "browser_tabs_create", arguments: { url: "https://nope.com" } });
  assert.equal(r.isError, true);
  assert.equal(text(r), "permission_denied: nope.com not allowed");
  host.close();
});

test("host dies mid-call → not_connected", async () => {
  const root = tmpRoot();
  const host = await fakeHost(root, "p1", "Work", (_m, s) => { s.destroy(); });
  const client = await connectClient({ root });
  const r: any = await client.callTool({ name: "browser_tabs_list", arguments: {} });
  assert.equal(r.isError, true);
  assert.match(text(r), /^not_connected:/);
  host.close();
});

test("timeout → timeout", async () => {
  const root = tmpRoot();
  const host = await fakeHost(root, "p1", "Work", () => {});
  const client = await connectClient({ root, callTimeoutMs: 100 });
  const r: any = await client.callTool({ name: "browser_tabs_list", arguments: {} });
  assert.equal(r.isError, true);
  assert.match(text(r), /^timeout:/);
  await sleep(10);
  host.close();
});
