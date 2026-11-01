import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { launch, webopBin, type Launched } from "./harness.ts";

const cleanups: (() => Promise<void>)[] = [];
after(async () => { for (const f of cleanups.reverse()) await f().catch(() => {}); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits for the host's descriptor, i.e. the extension connected and said hello. */
async function waitForDescriptor(root: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (readdirSync(join(root, "run")).some((n) => n.endsWith(".json"))) return;
    } catch { /* run dir not created yet */ }
    await sleep(100);
  }
  throw new Error("host descriptor never appeared");
}

async function mcpClient(root: string): Promise<Client> {
  const client = new Client({ name: "chain-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [webopBin, "mcp"],
    env: { ...(process.env as Record<string, string>), WEBOP_ROOT: root },
    stderr: "ignore",
  }));
  cleanups.push(() => client.close());
  return client;
}

async function chain() {
  const h = await launch({ nativeHost: true });
  cleanups.push(() => h.close());
  await waitForDescriptor(h.root);
  return { h, client: await mcpClient(h.root) };
}

type CallResult = Awaited<ReturnType<Client["callTool"]>>;
const blocks = (r: CallResult) => r.content as { type: string; text?: string; data?: string }[];
const textOf = (r: CallResult) => blocks(r).find((b) => b.type === "text")?.text ?? "";

test("end to end: tabs_create → read_page → click by ref → screenshot", async () => {
  const { h, client } = await chain();
  const created = await client.callTool({ name: "browser_tabs_create", arguments: { url: `${h.baseUrl}/button.html` } });
  assert.ok(!created.isError, textOf(created));
  const tab_id = JSON.parse(textOf(created)).tab_id as number;

  const tree = textOf(await client.callTool({ name: "browser_read_page", arguments: { tab_id, filter: "interactive" } }));
  const ref = /button "Click me" \[(ref_\d+)\]/.exec(tree)?.[1];
  assert.ok(ref, `no button ref in:\n${tree}`);

  const clicked = await client.callTool({ name: "browser_computer", arguments: { action: "left_click", tab_id, ref } });
  assert.ok(!clicked.isError, textOf(clicked));

  const shot = await client.callTool({ name: "browser_computer", arguments: { action: "screenshot", tab_id } });
  assert.ok(!shot.isError, textOf(shot));
  assert.ok(blocks(shot).some((b) => b.type === "image" && (b.data?.length ?? 0) > 100), "screenshot has no image");

  const page = h.context.pages().find((p) => p.url().endsWith("/button.html"));
  assert.ok(page);
  assert.equal(await page.title(), "clicked:true");
});

test("end to end: non-allowlisted site → isError permission_denied", async () => {
  const { h, client } = await chain();
  await h.sw.evaluate(() => chrome.storage.local.set({ "webop.deny": ["127.0.0.1"] }));
  const r = await client.callTool({ name: "browser_tabs_create", arguments: { url: `${h.altUrl}/button.html` } });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /^permission_denied/);
});

test("browser closed → not_connected; relaunch → next call succeeds", async () => {
  const first = await launch({ nativeHost: true });
  cleanups.push(() => first.close());
  await waitForDescriptor(first.root);
  const client = await mcpClient(first.root);
  const ok = await client.callTool({ name: "browser_tabs_list", arguments: {} });
  assert.ok(!ok.isError, textOf(ok));

  await first.close({ keepProfile: true });
  const down = await client.callTool({ name: "browser_tabs_list", arguments: {} });
  assert.equal(down.isError, true);
  assert.match(textOf(down), /^not_connected/);

  const second: Launched = await launch({ nativeHost: true, userDataDir: first.userDataDir, root: first.root });
  cleanups.push(() => second.close());
  // The old descriptor's host is dead, so the live one is the new host; give it time to register.
  let result: CallResult | undefined;
  for (let i = 0; i < 100; i++) {
    result = await client.callTool({ name: "browser_tabs_list", arguments: {} });
    if (!result.isError) break;
    await sleep(100);
  }
  assert.ok(result && !result.isError, result ? textOf(result) : "no result");
});

test("extension loaded before `webop install`: opening the options page connects immediately", async () => {
  const h = await launch();
  cleanups.push(() => h.close());
  // Let the SW fail a few connects so its backoff is well past the window checked below (retries at ~1, 3, 7 s; next ~15 s).
  await sleep(8_000);
  await h.installHost();
  const page = await h.context.newPage();
  await page.goto(`chrome-extension://${new URL(h.sw.url()).host}/options.html`);
  await waitForDescriptor(h.root, 4_000);
  const client = await mcpClient(h.root);
  const r = await client.callTool({ name: "browser_tabs_list", arguments: {} });
  assert.ok(!r.isError, textOf(r));
});

test("host connection lost: the extension releases the session's tabs", async () => {
  const { h, client } = await chain();
  const created = await client.callTool({ name: "browser_tabs_create", arguments: { url: `${h.baseUrl}/button.html` } });
  const tab_id = JSON.parse(textOf(created)).tab_id as number;
  const shot = await client.callTool({ name: "browser_computer", arguments: { action: "screenshot", tab_id } });
  assert.ok(!shot.isError, textOf(shot));
  const canAttach = () => h.sw.evaluate(async (id) => {
    try { await chrome.debugger.attach({ tabId: id }, "1.3"); } catch { return false; }
    await chrome.debugger.detach({ tabId: id });
    return true;
  }, tab_id);
  assert.equal(await canAttach(), false, "debugger should be attached while the session is live");
  // Kill the native host process: Chrome sees the port disconnect, with the MCP client's session still open.
  const run = join(h.root, "run");
  const desc = JSON.parse(readFileSync(join(run, readdirSync(run).find((n) => n.endsWith(".json")) as string), "utf8"));
  assert.equal(typeof desc.pid, "number");
  process.kill(desc.pid, "SIGKILL");
  let released = false;
  for (let i = 0; i < 50 && !released; i++) {
    await sleep(100);
    released = await canAttach();
  }
  assert.ok(released, "debugger still attached after the host connection dropped");
  assert.equal(await h.sw.evaluate((id) => chrome.tabs.get(id).then(() => true, () => false), tab_id), true);
});
