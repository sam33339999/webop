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
const until = async (f: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error("timeout"); await sleep(10); }
};

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
async function connectClient(opts: { root: string; callTimeoutMs?: number; profile?: string }) {
  const server = createMcpServer(opts);
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const text = (r: any) => r.content[0].text as string;

test("lists the browser_ tools", async () => {
  const client = await connectClient({ root: tmpRoot() });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "browser_computer", "browser_form_input", "browser_get_page_text", "browser_javascript", "browser_navigate", "browser_profile_select", "browser_profiles_list", "browser_read_page",
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

test("t_profiles_list: online profiles are listed with no selection", async () => {
  const root = tmpRoot();
  descriptor(root, "a", "Work");
  descriptor(root, "b", "Personal");
  const client = await connectClient({ root });
  const r: any = await client.callTool({ name: "browser_profiles_list", arguments: {} });
  assert.equal(r.isError, undefined, text(r));
  assert.deepEqual(JSON.parse(text(r)), [
    { profile_id: "a", profile_label: "Work", selected: false },
    { profile_id: "b", profile_label: "Personal", selected: false },
  ]);
});

test("t_select_then_call: calls go only to the selected profile", async () => {
  const root = tmpRoot();
  const answer = (tag: string): Handler => (m, s) =>
    writeLine(s, { type: "result", id: m.id, content: [{ type: "text", text: tag }] });
  const a = await fakeHost(root, "a", "Work", answer("A"));
  const b = await fakeHost(root, "b", "Personal", answer("B"));
  const client = await connectClient({ root });
  const sel: any = await client.callTool({ name: "browser_profile_select", arguments: { profile: "personal" } });
  assert.equal(sel.isError, undefined, text(sel));
  assert.match(text(sel), /Selected Personal/);
  assert.equal(text(await client.callTool({ name: "browser_tabs_list", arguments: {} }) as any), "B");
  // Ids work too, by exact id, and switching drops the old connection.
  await client.callTool({ name: "browser_profile_select", arguments: { profile: "a" } });
  assert.equal(text(await client.callTool({ name: "browser_tabs_list", arguments: {} }) as any), "A");
  const before = a.seen.filter((m) => m.type === "call").length;
  await client.callTool({ name: "browser_tabs_list", arguments: {} });
  assert.equal(a.seen.filter((m) => m.type === "call").length, before + 1);
  a.close();
  b.close();
});

test("t_second_profile_mid_session: a profile appearing mid-session makes calls profile_required until one is selected", async () => {
  const root = tmpRoot();
  const a = await fakeHost(root, "a", "Work", (m, s) =>
    writeLine(s, { type: "result", id: m.id, content: [{ type: "text", text: "A" }] }));
  const client = await connectClient({ root });
  assert.equal(text(await client.callTool({ name: "browser_tabs_list", arguments: {} }) as any), "A");
  const b = await fakeHost(root, "b", "Personal", () => {});
  await sleep(600);
  const callsBefore = a.seen.filter((m) => m.type === "call").length;
  const r: any = await client.callTool({ name: "browser_tabs_list", arguments: {} });
  assert.match(text(r), /^profile_required:/);
  assert.match(text(r), /Work \(a\)/);
  assert.match(text(r), /Personal \(b\)/);
  assert.equal(a.seen.filter((m) => m.type === "call").length, callsBefore, "the call was not forwarded");
  await client.callTool({ name: "browser_profile_select", arguments: { profile: "a" } });
  assert.equal(text(await client.callTool({ name: "browser_tabs_list", arguments: {} }) as any), "A");
  a.close();
  b.close();
});

test("t_bound_profile_gone: a selected profile going away answers not_connected, not the other profile", async () => {
  const root = tmpRoot();
  const a = await fakeHost(root, "a", "Work", (m, s) =>
    writeLine(s, { type: "result", id: m.id, content: [{ type: "text", text: "A" }] }));
  const b = await fakeHost(root, "b", "Personal", (m, s) =>
    writeLine(s, { type: "result", id: m.id, content: [{ type: "text", text: "B" }] }));
  const client = await connectClient({ root });
  await client.callTool({ name: "browser_profile_select", arguments: { profile: "b" } });
  assert.equal(text(await client.callTool({ name: "browser_tabs_list", arguments: {} }) as any), "B");
  fs.rmSync(descriptorPath("b", root));
  await sleep(600);
  const callsBefore = a.seen.filter((m) => m.type === "call").length;
  const r: any = await client.callTool({ name: "browser_tabs_list", arguments: {} });
  assert.match(text(r), /^not_connected:/);
  assert.match(text(r), /Personal/);
  assert.equal(a.seen.filter((m) => m.type === "call").length, callsBefore);
  a.close();
  b.close();
});

test("t_cli_profile_flag: --profile pins by id or case-insensitive label before any call", async () => {
  const root = tmpRoot();
  const answer = (tag: string): Handler => (m, s) =>
    writeLine(s, { type: "result", id: m.id, content: [{ type: "text", text: tag }] });
  const a = await fakeHost(root, "a", "Work", answer("A"));
  const b = await fakeHost(root, "b2", "Personal", answer("B"));
  const byLabel = await connectClient({ root, profile: "PERSONAL" });
  assert.equal(text(await byLabel.callTool({ name: "browser_tabs_list", arguments: {} }) as any), "B");
  const byId = await connectClient({ root, profile: "a" });
  assert.equal(text(await byId.callTool({ name: "browser_tabs_list", arguments: {} }) as any), "A");
  const unknown = await connectClient({ root, profile: "nope" });
  assert.match(text(await unknown.callTool({ name: "browser_tabs_list", arguments: {} }) as any), /^not_connected:/);
  a.close();
  b.close();
});

test("t_select_unknown_and_ambiguous", async () => {  const root = tmpRoot();
  descriptor(root, "a1", "Work");
  descriptor(root, "a2", "work");
  const client = await connectClient({ root });
  const none: any = await client.callTool({ name: "browser_profile_select", arguments: { profile: "nope" } });
  assert.match(text(none), /^not_connected:/);
  const ambiguous: any = await client.callTool({ name: "browser_profile_select", arguments: { profile: "WORK" } });
  assert.match(text(ambiguous), /^profile_required:/);
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

test("garbage lines from host are ignored; next result still resolves", async () => {
  const root = tmpRoot();
  const host = await fakeHost(root, "p1", "Work", (m, s) => {
    s.write("null\n\"x\"\n[1]\n");
    writeLine(s, { type: "result", id: m.id, content: [{ type: "text", text: "ok" }] });
  });
  const client = await connectClient({ root });
  const r: any = await client.callTool({ name: "browser_tabs_list", arguments: {} });
  assert.equal(text(r), "ok");
  host.close();
});

test("malformed result for pending call → internal promptly", async () => {
  const root = tmpRoot();
  const host = await fakeHost(root, "p1", "Work", (m, s) =>
    writeLine(s, { type: "result", id: m.id, content: "nope" }));
  const client = await connectClient({ root, callTimeoutMs: 5000 });
  const t0 = Date.now();
  const r: any = await client.callTool({ name: "browser_tabs_list", arguments: {} });
  assert.equal(r.isError, true);
  assert.match(text(r), /^internal:/);
  assert.ok(Date.now() - t0 < 2000);
  host.close();
});

test("concurrent first calls open exactly one session", async () => {
  const root = tmpRoot();
  const host = await fakeHost(root, "p1", "Work", (m, s) =>
    writeLine(s, { type: "result", id: m.id, content: [{ type: "text", text: "ok" }] }));
  const client = await connectClient({ root });
  const rs: any[] = await Promise.all([1, 2, 3].map(() => client.callTool({ name: "browser_tabs_list", arguments: {} })));
  assert.deepEqual(rs.map(text), ["ok", "ok", "ok"]);
  assert.equal(host.seen.filter((m) => m.type === "open").length, 1);
  assert.equal(host.socks.length, 1);
  host.close();
});

test("late result after timeout is ignored", async () => {
  const root = tmpRoot();
  const host = await fakeHost(root, "p1", "Work", (m, s) => {
    setTimeout(() => writeLine(s, { type: "result", id: m.id, content: [{ type: "text", text: "late" }] }), 250);
  });
  const client = await connectClient({ root, callTimeoutMs: 100 });
  const r: any = await client.callTool({ name: "browser_tabs_list", arguments: {} });
  assert.match(text(r), /^timeout:/);
  await sleep(400);
  host.close();
});

test("t_pending_extends_timeout: pending pushes the deadline out so a late result still lands", async () => {
  const root = tmpRoot();
  const host = await fakeHost(root, "p1", "Work", (m, s) => {
    setTimeout(() => writeLine(s, { type: "pending", id: m.id, extend_ms: 500 }), 100);
    setTimeout(() => writeLine(s, { type: "result", id: m.id, content: [{ type: "text", text: "granted" }] }), 600);
  });
  const client = await connectClient({ root, callTimeoutMs: 200 });
  const r: any = await client.callTool({ name: "browser_tabs_list", arguments: {} });
  assert.equal(r.isError, undefined);
  assert.equal(text(r), "granted");
  assert.equal(host.seen.filter((m) => m.type === "cancel").length, 0);
  host.close();
});

test("t_cancel_on_timeout: giving up sends cancel for the same id", async () => {
  const root = tmpRoot();
  const host = await fakeHost(root, "p1", "Work", () => {});
  const client = await connectClient({ root, callTimeoutMs: 100 });
  const r: any = await client.callTool({ name: "browser_tabs_list", arguments: {} });
  assert.match(text(r), /^timeout:/);
  const call = host.seen.find((m) => m.type === "call");
  await until(() => host.seen.some((m) => m.type === "cancel"));
  assert.deepEqual(host.seen.find((m) => m.type === "cancel"), { type: "cancel", id: call.id });
  host.close();
});

test("MCP client cancellation sends cancel to the host", async () => {
  const root = tmpRoot();
  const host = await fakeHost(root, "p1", "Work", () => {});
  const client = await connectClient({ root, callTimeoutMs: 5000 });
  const ac = new AbortController();
  const p = client.callTool({ name: "browser_tabs_list", arguments: {} }, undefined, { signal: ac.signal }).catch((e) => e);
  await until(() => host.seen.some((m) => m.type === "call"));
  ac.abort();
  await p;
  await until(() => host.seen.some((m) => m.type === "cancel"));
  assert.equal(host.seen.find((m) => m.type === "cancel").id, host.seen.find((m) => m.type === "call").id);
  host.close();
});

test("malformed pending is ignored: the original timeout still fires", async () => {
  const root = tmpRoot();
  const host = await fakeHost(root, "p1", "Work", (m, s) => {
    for (const bad of ["x", -1, 0, 1.5, null]) writeLine(s, { type: "pending", id: m.id, extend_ms: bad });
    setTimeout(() => writeLine(s, { type: "result", id: m.id, content: [{ type: "text", text: "late" }] }), 400);
  });
  const client = await connectClient({ root, callTimeoutMs: 100 });
  const r: any = await client.callTool({ name: "browser_tabs_list", arguments: {} });
  assert.match(text(r), /^timeout:/);
  host.close();
});

test("pending for an unknown id is a no-op", async () => {
  const root = tmpRoot();
  const host = await fakeHost(root, "p1", "Work", (m, s) => {
    writeLine(s, { type: "pending", id: "nope", extend_ms: 5000 });
    setTimeout(() => writeLine(s, { type: "result", id: m.id, content: [{ type: "text", text: "late" }] }), 400);
  });
  const client = await connectClient({ root, callTimeoutMs: 100 });
  const r: any = await client.callTool({ name: "browser_tabs_list", arguments: {} });
  assert.match(text(r), /^timeout:/);
  host.close();
});

test("already-aborted client signal sends no call", async () => {
  const root = tmpRoot();
  const host = await fakeHost(root, "p1", "Work", () => {});
  const client = await connectClient({ root, callTimeoutMs: 5000 });
  const ac = new AbortController();
  ac.abort();
  await client.callTool({ name: "browser_tabs_list", arguments: {} }, undefined, { signal: ac.signal }).catch(() => {});
  await sleep(100);
  assert.equal(host.seen.filter((m) => m.type === "call").length, 0);
  host.close();
});

test("timeout message reports the total waited after an extension", async () => {
  const root = tmpRoot();
  const host = await fakeHost(root, "p1", "Work", (m, s) => setTimeout(() => writeLine(s, { type: "pending", id: m.id, extend_ms: 200 }), 50));
  const client = await connectClient({ root, callTimeoutMs: 100 });
  const r: any = await client.callTool({ name: "browser_tabs_list", arguments: {} });
  const ms = Number(/after (\d+) ms/.exec(text(r))?.[1]);
  assert.ok(ms >= 300, text(r));
  host.close();
});

test("t_budget_flags_sent: the screenshot budget goes out with open", async () => {
  const root = tmpRoot();
  const host = await fakeHost(root, "p1", "Work", (m, s) =>
    writeLine(s, { type: "result", id: m.id, content: [{ type: "text", text: "ok" }] }));
  const server = createMcpServer({ root, budget: { pxPerToken: 28, maxTargetPx: 1024, maxTargetTokens: 1568 } });
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  await client.callTool({ name: "browser_tabs_list", arguments: {} });
  const open = host.seen.find((m) => m.type === "open");
  assert.deepEqual(open.budget, { pxPerToken: 28, maxTargetPx: 1024, maxTargetTokens: 1568 });
  host.close();
});

test("no budget flags: open carries no budget", async () => {
  const root = tmpRoot();
  const host = await fakeHost(root, "p1", "Work", (m, s) =>
    writeLine(s, { type: "result", id: m.id, content: [{ type: "text", text: "ok" }] }));
  const client = await connectClient({ root });
  await client.callTool({ name: "browser_tabs_list", arguments: {} });
  assert.equal(host.seen.find((m) => m.type === "open").budget, undefined);
  host.close();
});
