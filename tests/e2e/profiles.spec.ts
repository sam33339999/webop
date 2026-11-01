import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { launch, webopBin, type Launched } from "./harness.ts";

const cleanups: (() => Promise<void>)[] = [];
after(async () => { for (const f of cleanups.reverse()) await f().catch(() => {}); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Descriptor = { profile_id: string; profile_label: string; pid: number };

async function descriptors(root: string): Promise<Descriptor[]> {
  let names: string[];
  try {
    names = (await readdir(join(root, "run"))).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Descriptor[] = [];
  for (const n of names) {
    try { out.push(JSON.parse(await readFile(join(root, "run", n), "utf8"))); } catch { /* being rewritten */ }
  }
  return out;
}

async function waitFor<T>(fn: () => Promise<T | undefined | false>, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function mcpClient(root: string, extra: string[] = []): Promise<Client> {
  const client = new Client({ name: "profiles-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [webopBin, "mcp", ...extra],
    env: { ...(process.env as Record<string, string>), WEBOP_ROOT: root },
    stderr: "ignore",
  }));
  cleanups.push(() => client.close());
  return client;
}

type CallResult = Awaited<ReturnType<Client["callTool"]>>;
const textOf = (r: CallResult) => (r.content as { type: string; text?: string }[]).find((b) => b.type === "text")?.text ?? "";

async function started(o: { root?: string } = {}): Promise<Launched> {
  const h = await launch({ nativeHost: true, root: o.root });
  cleanups.push(() => h.close());
  return h;
}

const profileIdOf = (h: Launched) => h.sw.evaluate(async () => (await chrome.storage.local.get("webop.profile_id"))["webop.profile_id"] as string);

test("t_label_default_and_rename: the default label is profile-<id>; renaming in options updates the descriptor live", async () => {
  const h = await started();
  const [d] = await waitFor(async () => { const l = await descriptors(h.root); return l.length === 1 && l; }, "descriptor");
  const id = await profileIdOf(h);
  assert.equal(d!.profile_id, id);
  // Headless Chromium has no signed-in account, so the email fallback is empty.
  assert.equal(d!.profile_label, `profile-${id.slice(0, 6)}`);

  const page = await h.context.newPage();
  await page.goto(`chrome-extension://${new URL(h.sw.url()).host}/options.html`);
  await page.locator("#profile-label").fill("  Work  ");
  await page.locator("#save-label").click();
  await page.locator("#label-status").filter({ hasText: "Saved." }).waitFor();
  await waitFor(async () => (await descriptors(h.root))[0]?.profile_label === "Work", "renamed descriptor");

  const client = await mcpClient(h.root);
  const listed = JSON.parse(textOf(await client.callTool({ name: "browser_profiles_list", arguments: {} })));
  assert.deepEqual(listed, [{ profile_id: id, profile_label: "Work", selected: false }]);

  // Clearing the name falls back again.
  await page.locator("#profile-label").fill("");
  await page.locator("#save-label").click();
  await waitFor(async () => (await descriptors(h.root))[0]?.profile_label === `profile-${id.slice(0, 6)}`, "fallback label");
});

test("t_two_real_profiles: two browsers on one root; select picks one and tabs open only there", async () => {
  const root = await mkdtemp("/tmp/wr-");
  const a = await started({ root });
  await a.sw.evaluate(() => chrome.storage.local.set({ "webop.profile_label": "Alpha" }));
  const b = await started({ root });
  await b.sw.evaluate(() => chrome.storage.local.set({ "webop.profile_label": "Beta" }));
  await waitFor(async () => {
    const labels = (await descriptors(root)).map((d) => d.profile_label).sort();
    return labels.join(",") === "Alpha,Beta";
  }, "both descriptors labelled");

  const client = await mcpClient(root);
  const ambiguous = await client.callTool({ name: "browser_tabs_list", arguments: {} });
  assert.equal(ambiguous.isError, true);
  assert.match(textOf(ambiguous), /^profile_required: .*Alpha.*Beta|^profile_required: .*Beta.*Alpha/);

  const sel = await client.callTool({ name: "browser_profile_select", arguments: { profile: "beta" } });
  assert.ok(!sel.isError, textOf(sel));
  const created = await client.callTool({ name: "browser_tabs_create", arguments: { url: `${b.baseUrl}/button.html` } });
  assert.ok(!created.isError, textOf(created));
  const onB = await b.sw.evaluate(() => chrome.tabs.query({}).then((ts) => ts.map((t) => t.url ?? "")));
  const onA = await a.sw.evaluate(() => chrome.tabs.query({}).then((ts) => ts.map((t) => t.url ?? "")));
  assert.ok(onB.some((u) => u.endsWith("/button.html")), `tab not in Beta: ${onB.join(", ")}`);
  assert.ok(!onA.some((u) => u.endsWith("/button.html")), `tab leaked into Alpha: ${onA.join(", ")}`);

  const listed = JSON.parse(textOf(await client.callTool({ name: "browser_profiles_list", arguments: {} }))) as { profile_label: string; selected: boolean }[];
  assert.deepEqual(listed.filter((p) => p.selected).map((p) => p.profile_label), ["Beta"]);
});

test("t_cli_profile_flag: `webop mcp --profile <label>` binds without a select call", async () => {
  const root = await mkdtemp("/tmp/wr-");
  const a = await started({ root });
  await a.sw.evaluate(() => chrome.storage.local.set({ "webop.profile_label": "Alpha" }));
  const b = await started({ root });
  await b.sw.evaluate(() => chrome.storage.local.set({ "webop.profile_label": "Beta" }));
  await waitFor(async () => (await descriptors(root)).map((d) => d.profile_label).sort().join(",") === "Alpha,Beta", "both labelled");

  const client = await mcpClient(root, ["--profile", "ALPHA"]);
  const created = await client.callTool({ name: "browser_tabs_create", arguments: { url: `${a.baseUrl}/button.html` } });
  assert.ok(!created.isError, textOf(created));
  const onA = await a.sw.evaluate(() => chrome.tabs.query({}).then((ts) => ts.map((t) => t.url ?? "")));
  assert.ok(onA.some((u) => u.endsWith("/button.html")), `tab not in Alpha: ${onA.join(", ")}`);
});

/** Headless browsers quit with their last window, so the window count is substituted through a dev hook. */
async function setWindows(h: Launched, n: number | null): Promise<void> {
  await h.sw.evaluate((count) => {
    const w = (globalThis as any).__webop;
    w.nativeDevHooks.normalWindows = count === null ? undefined : async () => count;
  }, n);
}

test("t_last_window_closed_goes_offline: no window → host exits and stays down; a window → back online", async () => {
  const root = await mkdtemp("/tmp/wr-");
  const a = await started({ root });
  await a.sw.evaluate(() => chrome.storage.local.set({ "webop.profile_label": "Alpha" }));
  const b = await started({ root });
  await b.sw.evaluate(() => chrome.storage.local.set({ "webop.profile_label": "Beta" }));
  await waitFor(async () => (await descriptors(root)).map((d) => d.profile_label).sort().join(",") === "Alpha,Beta", "both labelled");
  const client = await mcpClient(root);
  assert.ok(!(await client.callTool({ name: "browser_profile_select", arguments: { profile: "Beta" } })).isError);
  const created = await client.callTool({ name: "browser_tabs_create", arguments: { url: `${b.baseUrl}/button.html` } });
  assert.ok(!created.isError, textOf(created));

  // Beta's last normal window closes.
  await setWindows(b, 0);
  await b.sw.evaluate(() => (globalThis as any).__webop.onWindowClosed());
  await waitFor(async () => (await descriptors(root)).map((d) => d.profile_label).join(",") === "Alpha", "Beta descriptor removed");
  // It must stay down: no respawned host after the reconnect backoff would have fired.
  await sleep(2_500);
  assert.deepEqual((await descriptors(root)).map((d) => d.profile_label), ["Alpha"]);
  assert.deepEqual(await b.sw.evaluate(() => (globalThis as any).__webop.linkState()), { connected: false, waitingForWindow: true });

  const listed = JSON.parse(textOf(await client.callTool({ name: "browser_profiles_list", arguments: {} }))) as { profile_label: string }[];
  assert.deepEqual(listed.map((p) => p.profile_label), ["Alpha"]);
  const r = await client.callTool({ name: "browser_tabs_create", arguments: { url: `${a.baseUrl}/button.html` } });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /^not_connected: Profile "Beta" is not online\. Online: Alpha/);
  const onA = await a.sw.evaluate(() => chrome.tabs.query({}).then((ts) => ts.map((t) => t.url ?? "")));
  assert.ok(!onA.some((u) => u.endsWith("/button.html")), "must not fall back to Alpha");

  // Even an explicit wake (SW restart, backoff timer) does not bring a host up without a window.
  await b.sw.evaluate(() => (globalThis as any).__webop.onWindowOpened());
  await sleep(500);
  assert.deepEqual((await descriptors(root)).map((d) => d.profile_label), ["Alpha"]);

  // A window opens again: Beta is back and usable with the same selection.
  await setWindows(b, null);
  await b.sw.evaluate(() => (globalThis as any).__webop.onWindowOpened());
  await waitFor(async () => (await descriptors(root)).length === 2, "Beta back online");
  const again = await client.callTool({ name: "browser_tabs_create", arguments: { url: `${b.baseUrl}/button.html` } });
  assert.ok(!again.isError, textOf(again));
});

test("t_popup_window_keeps_profile_online: closing a window while a normal one remains changes nothing", async () => {
  const h = await started();
  await waitFor(async () => (await descriptors(h.root)).length === 1, "descriptor");
  // A popup (the permission prompt) opening and closing is not the profile closing.
  await h.sw.evaluate(async () => {
    const w = await chrome.windows.create({ url: "about:blank", type: "popup" });
    await chrome.windows.remove(w!.id!);
  });
  await h.sw.evaluate(() => (globalThis as any).__webop.onWindowClosed());
  await sleep(500);
  assert.equal((await descriptors(h.root)).length, 1);
  assert.deepEqual(await h.sw.evaluate(() => (globalThis as any).__webop.linkState()), { connected: true, waitingForWindow: false });
});
