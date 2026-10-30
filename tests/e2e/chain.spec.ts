import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
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
