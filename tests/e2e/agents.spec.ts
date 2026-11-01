import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { launch, webopBin, type Launched } from "./harness.ts";

const cleanups: (() => Promise<void>)[] = [];
after(async () => { for (const f of cleanups.reverse()) await f().catch(() => {}); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type CallResult = Awaited<ReturnType<Client["callTool"]>>;
const textOf = (r: CallResult) => (r.content as { type: string; text?: string }[]).find((b) => b.type === "text")?.text ?? "";

async function browser(): Promise<Launched> {
  const h = await launch({ nativeHost: true });
  cleanups.push(() => h.close());
  const online = () => { try { return readdirSync(join(h.root, "run")).some((n) => n.endsWith(".json")); } catch { return false; } };
  for (let i = 0; i < 100 && !online(); i++) await sleep(100);
  assert.ok(online(), "host never registered");
  return h;
}

/** An agent: its own `webop mcp` process, introducing itself as `name` (the session's client_name). */
async function agent(h: Launched, name: string): Promise<Client> {
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [webopBin, "mcp"],
    env: { ...(process.env as Record<string, string>), WEBOP_ROOT: h.root }, stderr: "ignore",
  }));
  cleanups.push(() => client.close());
  return client;
}

async function openTab(c: Client, url: string): Promise<number> {
  const r = await c.callTool({ name: "browser_tabs_create", arguments: { url } });
  assert.ok(!r.isError, textOf(r));
  return JSON.parse(textOf(r)).tab_id as number;
}

const groups = (h: Launched) => h.sw.evaluate(() => chrome.tabGroups.query({}).then((gs) => gs.map((g) => ({ id: g.id, title: g.title, color: g.color }))));
const groupOf = (h: Launched, tabId: number) => h.sw.evaluate((id) => chrome.tabs.get(id).then((t) => t.groupId), tabId);
const tabIdsOf = async (c: Client) => (JSON.parse(textOf(await c.callTool({ name: "browser_tabs_list", arguments: {} }))) as { tab_id: number }[]).map((t) => t.tab_id);

const promptPages = (h: Launched): Page[] => h.context.pages().filter((p) => p.url().includes("prompt.html"));
async function popupFor(h: Launched, client: string): Promise<Page> {
  for (let i = 0; i < 200; i++) {
    for (const p of promptPages(h)) {
      if ((await p.locator("#client").textContent().catch(() => "")) === client) return p;
    }
    await sleep(50);
  }
  throw new Error(`no prompt for ${client}`);
}

test("t_two_agents_own_groups: each agent gets its own titled, coloured group and sees only its tabs", async () => {
  const h = await browser();
  const oc = await agent(h, "opencode");
  const gk = await agent(h, "grok");
  const a = await openTab(oc, `${h.baseUrl}/button.html`);
  const b = await openTab(gk, `${h.baseUrl}/button.html`);
  const gs = await groups(h);
  assert.deepEqual(gs.map((g) => g.title).sort(), ["webop · grok", "webop · opencode"]);
  assert.notEqual(gs[0]!.color, gs[1]!.color);
  const [ga, gb] = [await groupOf(h, a), await groupOf(h, b)];
  assert.equal(gs.find((g) => g.id === ga)?.title, "webop · opencode");
  assert.equal(gs.find((g) => g.id === gb)?.title, "webop · grok");
  assert.deepEqual(await tabIdsOf(oc), [a]);
  assert.deepEqual(await tabIdsOf(gk), [b]);
});

test("t_two_agents_isolated: one agent cannot read, capture or close the other's tab", async () => {
  const h = await browser();
  const oc = await agent(h, "opencode");
  const gk = await agent(h, "grok");
  const a = await openTab(oc, `${h.baseUrl}/button.html`);
  for (const [name, args] of [
    ["browser_computer", { action: "screenshot", tab_id: a }],
    ["browser_read_page", { tab_id: a }],
    ["browser_get_page_text", { tab_id: a }],
    ["browser_tabs_close", { tab_id: a }],
  ] as const) {
    const r = await gk.callTool({ name, arguments: args });
    assert.equal(r.isError, true, `${name} must be refused`);
    assert.match(textOf(r), /^tab_not_in_session/, name);
  }
  assert.ok(await h.sw.evaluate((id) => chrome.tabs.get(id).then(() => true, () => false), a), "the tab must still exist");
});

test("t_two_agents_concurrent: both agents click their own pages at the same time", async () => {
  const h = await browser();
  const oc = await agent(h, "opencode");
  const gk = await agent(h, "grok");
  const ta = await openTab(oc, `${h.baseUrl}/button.html?a`);
  const tb = await openTab(gk, `${h.baseUrl}/button.html?b`);
  const refOf = async (c: Client, tab_id: number) => /button "Click me" \[(ref_\d+)\]/.exec(textOf(await c.callTool({ name: "browser_read_page", arguments: { tab_id, filter: "interactive" } })))![1]!;
  const [ra, rb] = await Promise.all([refOf(oc, ta), refOf(gk, tb)]);
  const clicks = (c: Client, tab_id: number, ref: string) => Array.from({ length: 5 }, () => c.callTool({ name: "browser_computer", arguments: { action: "left_click", tab_id, ref } }));
  const results = await Promise.all([...clicks(oc, ta, ra), ...clicks(gk, tb, rb)]);
  assert.deepEqual(results.filter((r) => r.isError).map(textOf), []);
  const titles = await Promise.all(["?a", "?b"].map(async (q) => h.context.pages().find((p) => p.url().endsWith(`/button.html${q}`))!.title()));
  assert.deepEqual(titles, ["clicked:true", "clicked:true"]);
});

test("t_two_agents_once_grant_is_per_session: allowing one agent once does not allow the other", async () => {
  const h = await browser();
  const oc = await agent(h, "opencode");
  const gk = await agent(h, "grok");
  const first = oc.callTool({ name: "browser_tabs_create", arguments: { url: `${h.altUrl}/button.html` } });
  await (await popupFor(h, "opencode")).getByRole("button", { name: "本次允許" }).click();
  assert.ok(!(await first).isError, textOf(await first));
  const second = gk.callTool({ name: "browser_tabs_create", arguments: { url: `${h.altUrl}/button.html` } });
  await (await popupFor(h, "grok")).getByRole("button", { name: "拒絕" }).click();
  const r = await second;
  assert.equal(r.isError, true);
  assert.match(textOf(r), /^permission_denied/);
});

test("t_two_agents_stop_one: stopping one agent's tab leaves the other agent working", async () => {
  const h = await browser();
  const oc = await agent(h, "opencode");
  const gk = await agent(h, "grok");
  const a = await openTab(oc, `${h.baseUrl}/button.html`);
  // opencode is waiting on a prompt when its stop button is pressed.
  const waiting = oc.callTool({ name: "browser_navigate", arguments: { tab_id: a, url: `${h.altUrl}/button.html` } });
  await popupFor(h, "opencode");
  await h.sw.evaluate(async (tabId) => {
    const s = (await chrome.storage.session.get("webop.sessions"))["webop.sessions"] as { sessions: Record<string, { tabIds: number[] }> };
    const id = Object.entries(s.sessions).find(([, st]) => st.tabIds.includes(tabId))![0];
    await (globalThis as any).__webop.stopSession(id);
  }, a);
  const stopped = await waiting;
  assert.equal(stopped.isError, true);
  assert.match(textOf(stopped), /^stopped_by_user/);
  const b = await openTab(gk, `${h.baseUrl}/button.html`);
  const shot = await gk.callTool({ name: "browser_computer", arguments: { action: "screenshot", tab_id: b } });
  assert.ok(!shot.isError, textOf(shot));
});

test("t_same_client_name_separate_groups: two agents with the same name still get separate groups", async () => {
  const h = await browser();
  const one = await agent(h, "opencode");
  const two = await agent(h, "opencode");
  const a = await openTab(one, `${h.baseUrl}/button.html`);
  const b = await openTab(two, `${h.baseUrl}/button.html`);
  const ga = await groupOf(h, a);
  const gb = await groupOf(h, b);
  assert.notEqual(ga, gb);
  const gs = await groups(h);
  assert.notEqual(gs.find((g) => g.id === ga)!.color, gs.find((g) => g.id === gb)!.color);
  const r = await two.callTool({ name: "browser_read_page", arguments: { tab_id: a } });
  assert.match(textOf(r), /^tab_not_in_session/);
});
