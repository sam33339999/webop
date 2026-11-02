import { test, after } from "node:test";
import assert from "node:assert/strict";
import { call, launch, openTab, type Launched } from "./harness.ts";

const opened: Launched[] = [];
async function open(grants: Record<string, string[]> = { localhost: ["act"] }) {
  const h = await launch();
  opened.push(h);
  await h.sw.evaluate((g) => chrome.storage.local.set({ "webop.grants": g }), grants);
  return h;
}
after(async () => { for (const h of opened) await h.close(); });

type R = Awaited<ReturnType<typeof call>>;
const errOf = (r: R) => { assert.ok("error" in r, `expected an error, got ${JSON.stringify(r).slice(0, 300)}`); return r.error; };
const textOf = (r: R): string => {
  assert.ok("content" in r, "error" in r ? `${r.error.code}: ${r.error.message}` : "no content");
  const t = r.content[0];
  assert.ok(t && t.type === "text");
  return t.text;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Entry lines only: the summary line and any notes are dropped. */
const entries = (text: string): string[] => text.split("\n").slice(1).filter((l) => !l.startsWith("Note:"));

/** tabs_create on logs.html, then a short pause so the page's fetches have finished. */
async function openLogs(h: Launched): Promise<number> {
  const { tab_id } = JSON.parse(textOf(await call(h.sw, "tabs_create", { url: `${h.baseUrl}/logs.html` }))) as { tab_id: number };
  await sleep(200);
  return tab_id;
}
const readNet = (h: Launched, tab_id: number, args: object = {}) => call(h.sw, "read_network_requests", { tab_id, ...args });

async function waitForUrl(h: Launched, tab_id: number, want: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const ok = await h.sw.evaluate(([id, w]) => chrome.tabs.get(id).then((t) => t.status === "complete" && t.url === w), [tab_id, want] as const);
    if (ok) return;
    await sleep(100);
  }
  throw new Error(`tab never settled on ${want}`);
}

test("t_net_first_load: the first document and its subresources are recorded, with credentials redacted", async () => {
  const h = await open();
  const tab_id = await openLogs(h);
  const text = textOf(await readNet(h, tab_id));
  assert.match(text, /document \S*\/logs\.html/, text);
  assert.ok(text.includes("status/200?token=REDACTED&q=1"), text);
  assert.ok(text.includes(" 500 "), text);
  assert.ok(text.includes(" 404 "), text);
  assert.ok(text.includes("failed net::ERR_CONNECTION_REFUSED"), text);
  assert.ok(!text.includes("token=abc"), text);
});

test("t_net_filters: only_failed, url_pattern, resource_type and limit", async () => {
  const h = await open();
  const tab_id = await openLogs(h);
  const failed = textOf(await readNet(h, tab_id, { only_failed: true }));
  assert.ok(!failed.includes("status/200"), failed);
  assert.ok(failed.includes("status/500"), failed);
  const status = entries(textOf(await readNet(h, tab_id, { url_pattern: "status/" })));
  assert.equal(status.length, 2, status.join("\n"));
  assert.ok(status.every((l) => l.includes("status/")), status.join("\n"));
  const docs = entries(textOf(await readNet(h, tab_id, { resource_type: "document" })));
  assert.ok(docs.length >= 1 && docs.every((l) => l.includes("logs.html")), docs.join("\n"));
  const limited = textOf(await readNet(h, tab_id, { limit: 1 }));
  assert.match(limited.split("\n")[0], /^\d+ matching, 1 shown/, limited);
  assert.equal(entries(limited).length, 1, limited);
  for (const limit of [0, -1, 1.5, "2"]) assert.equal(errOf(await readNet(h, tab_id, { limit })).code, "invalid_args", `limit ${limit}`);
  assert.equal(errOf(await readNet(h, tab_id, { only_failed: "yes" })).code, "invalid_args");
  assert.equal(errOf(await call(h.sw, "read_network_requests", {})).code, "invalid_args");
});

test("t_net_clear: clear returns this read's entries, then empties the buffer", async () => {
  const h = await open();
  const tab_id = await openLogs(h);
  const first = textOf(await readNet(h, tab_id, { clear: true }));
  assert.ok(first.includes("logs.html"), first);
  const second = textOf(await readNet(h, tab_id));
  assert.match(second, /^0 matching/, second);
});

test("t_net_site_change_clears: navigating to another site empties the buffer", async () => {
  const h = await open({ localhost: ["act"], "127.0.0.1": ["act"] });
  const tab_id = await openLogs(h);
  textOf(await call(h.sw, "navigate", { tab_id, url: `${h.altUrl}/logs.html` }));
  await sleep(200);
  const lines = entries(textOf(await readNet(h, tab_id)));
  assert.ok(lines.length > 0, "nothing recorded on the new site");
  assert.ok(lines.every((l) => l.includes("127.0.0.1")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("/refused")), lines.join("\n"));
  assert.ok(!lines.some((l) => l.includes("localhost")), lines.join("\n"));
});

test("t_net_same_site_keeps: navigating within the site keeps earlier entries", async () => {
  const h = await open();
  const tab_id = await openLogs(h);
  textOf(await call(h.sw, "navigate", { tab_id, url: `${h.baseUrl}/button.html` }));
  const text = textOf(await readNet(h, tab_id));
  assert.ok(text.includes("logs.html"), text);
  assert.ok(text.includes("button.html"), text);
});

test("t_net_redirect_away_and_back: a hop through another site leaves nothing of it behind", async () => {
  const h = await open({ localhost: ["act"], "127.0.0.1": ["act"] });
  const tab_id = await openLogs(h);
  const back = `${h.baseUrl}/logs.html`;
  const via = `${h.altUrl}/logs-redirect.html?to=${encodeURIComponent(back)}`;
  await call(h.sw, "navigate", { tab_id, url: `${h.baseUrl}/logs-redirect.html?to=${encodeURIComponent(via)}` });
  await waitForUrl(h, tab_id, back);
  await sleep(200);
  const lines = entries(textOf(await readNet(h, tab_id)));
  assert.ok(lines.some((l) => l.includes("logs.html")), lines.join("\n"));
  // The final page's refused fetch also goes to 127.0.0.1 (another port); only the hop's own requests must be gone.
  const hop = lines.filter((l) => l.includes(`127.0.0.1:${new URL(h.altUrl).port}`));
  assert.deepEqual(hop, [], lines.join("\n"));
  assert.equal(lines.filter((l) => /document \S*\/logs\.html$/.test(l)).length, 1, lines.join("\n"));
});

test("t_net_unauthorized: a tab on a site the session may not read gets permission_required and no entries", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/redirect.html?to=${encodeURIComponent(`${h.altUrl}/logs.html`)}`);
  for (let i = 0; i < 100 && !(await h.sw.evaluate((id) => chrome.tabs.get(id).then((t) => t.status === "complete" && (t.url ?? "").includes("127.0.0.1")), tab_id)); i++) {
    await sleep(100);
  }
  const e = errOf(await readNet(h, tab_id));
  assert.equal(e.code, "permission_required");
  assert.ok(!e.message.includes("logs.html") && !e.message.includes("status/"), e.message);
});

test("t_net_no_attach_when_detached: reading after a detach answers from the buffer and does not re-attach", async () => {
  const h = await open();
  const tab_id = await openLogs(h);
  await h.sw.evaluate((id) => (globalThis as any).__webop.simulateDetach(id, "canceled_by_user"), tab_id);
  await sleep(100);
  const text = textOf(await readNet(h, tab_id));
  const lines = text.split("\n");
  assert.ok(lines.slice(1).some((l) => l.includes("recording is paused")), text);
  assert.ok(text.includes("logs.html"), text);
  const attached = await h.sw.evaluate((id) => chrome.debugger.getTargets().then((ts) => ts.some((t) => t.tabId === id && t.attached && t.extensionId === chrome.runtime.id)), tab_id);
  assert.equal(attached, false);
});

test("t_net_no_runtime_enable: recording the network never enables the Runtime domain", async () => {
  const h = await open();
  const tab_id = await openLogs(h);
  textOf(await readNet(h, tab_id));
  const sent = await h.sw.evaluate(() => [...(globalThis as any).__webop.devSent] as string[]);
  assert.ok(sent.includes(`${tab_id} Network.enable`), sent.join("\n"));
  assert.ok(!sent.includes(`${tab_id} Runtime.enable`), sent.join("\n"));
});
