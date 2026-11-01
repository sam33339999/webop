import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { extensionIdFromKey } from "@webop/core/extension-id";
import { launch, seaBin } from "./harness.ts";
import manifest from "../../apps/extension/manifest.json" with { type: "json" };

const cleanups: (() => Promise<void>)[] = [];
after(async () => { for (const f of cleanups.reverse()) await f().catch(() => {}); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type CallResult = Awaited<ReturnType<Client["callTool"]>>;
const textOf = (r: CallResult) => (r.content as { type: string; text?: string }[]).find((b) => b.type === "text")?.text ?? "";

test("t_sea_install_prints_self: install from the SEA points the wrapper at the SEA itself", async () => {
  const browserDir = mkdtempSync(join(tmpdir(), "wsb-"));
  const root = mkdtempSync("/tmp/wsr-");
  const r = spawnSync(seaBin, ["install", "--browser-dir", browserDir], { encoding: "utf8", env: { ...process.env, WEBOP_ROOT: root } });
  assert.equal(r.status, 0, r.stderr);
  const wrapper = readFileSync(join(root, "bin", "webop-native-host"), "utf8");
  assert.ok(wrapper.includes(`exec '${seaBin}' native-host`), wrapper);
  assert.ok(!/\bnode\b/.test(wrapper.replace(seaBin, "")), wrapper);
  assert.match(r.stdout, new RegExp(`grok mcp add webop '?${seaBin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'? -- mcp`));
  const m = JSON.parse(readFileSync(join(browserDir, "NativeMessagingHosts", "com.webop.native_host.json"), "utf8"));
  assert.deepEqual(m.allowed_origins, [`chrome-extension://${await extensionIdFromKey(manifest.key)}/`]);
});

test("t_sea_chain: browser → SEA native host → SEA mcp works end to end", async () => {
  const h = await launch({ nativeHost: true, webopCommand: [seaBin] });
  cleanups.push(() => h.close());
  const online = () => { try { return readdirSync(join(h.root, "run")).some((n) => n.endsWith(".json")); } catch { return false; } };
  for (let i = 0; i < 100 && !online(); i++) await sleep(100);
  assert.ok(online(), "the SEA native host never registered");
  const wrapper = readFileSync(join(h.root, "bin", "webop-native-host"), "utf8");
  assert.ok(wrapper.includes(`'${seaBin}' native-host`) && !wrapper.includes(process.execPath), wrapper);
  const client = new Client({ name: "sea-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({
    command: seaBin, args: ["mcp"], env: { ...(process.env as Record<string, string>), WEBOP_ROOT: h.root }, stderr: "ignore",
  }));
  cleanups.push(() => client.close());
  const created = await client.callTool({ name: "browser_tabs_create", arguments: { url: `${h.baseUrl}/button.html` } });
  assert.ok(!created.isError, textOf(created));
  const tab_id = JSON.parse(textOf(created)).tab_id as number;
  const tree = await client.callTool({ name: "browser_read_page", arguments: { tab_id, filter: "interactive" } });
  assert.match(textOf(tree), /button "Click me"/);
});
