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

test("t_net_redirect302_away_and_back: a server-side 302 hop through another site leaves nothing of it behind", async () => {
  const h = await open({ localhost: ["act"], "127.0.0.1": ["act"] });
  const tab_id = await openLogs(h);
  const back = `${h.baseUrl}/logs.html`;
  await call(h.sw, "navigate", { tab_id, url: `${h.altUrl}/redirect302?to=${encodeURIComponent(back)}` });
  await waitForUrl(h, tab_id, back);
  await sleep(200);
  const lines = entries(textOf(await readNet(h, tab_id)));
  assert.ok(lines.some((l) => l.includes("logs.html")), lines.join("\n"));
  const hop = lines.filter((l) => l.includes(`127.0.0.1:${new URL(h.altUrl).port}`));
  assert.deepEqual(hop, [], lines.join("\n"));
  assert.equal(lines.filter((l) => /document \S*\/logs\.html$/.test(l)).length, 1, lines.join("\n"));
});

// ---- console ----

const readCon = (h: Launched, tab_id: number, args: object = {}) => call(h.sw, "read_console_messages", { tab_id, ...args });
const devSent = (h: Launched) => h.sw.evaluate(() => [...(globalThis as any).__webop.devSent] as string[]);
const countOf = (sent: string[], line: string) => sent.filter((s) => s === line).length;
const isAttachedByUs = (h: Launched, tab_id: number) =>
  h.sw.evaluate((id) => chrome.debugger.getTargets().then((ts) => ts.some((t) => t.tabId === id && t.attached && t.extensionId === chrome.runtime.id)), tab_id);

/** Screenshot first (coordinates are screenshot-frame), then clicks the #b button of logs.html. */
async function clickLogButton(h: Launched, tab_id: number): Promise<void> {
  textOf(await call(h.sw, "computer", { action: "screenshot", tab_id }));
  const page = h.context.pages().find((p) => p.url().includes("/logs.html"));
  assert.ok(page);
  const ctx = await h.sw.evaluate((id) => (globalThis as any).__webop.getContext(id), tab_id);
  const r = await page.evaluate(() => {
    const b = document.querySelector("#b")!.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
  const coordinate = [(r.x * ctx.screenshotWidth) / ctx.viewportWidth, (r.y * ctx.screenshotHeight) / ctx.viewportHeight];
  textOf(await call(h.sw, "computer", { action: "left_click", tab_id, coordinate }));
}

test("t_console_lazy: Runtime is enabled only by the first console read", async () => {
  const h = await open();
  const tab_id = await openLogs(h);
  assert.ok(!(await devSent(h)).includes(`${tab_id} Runtime.enable`));
  const text = textOf(await readCon(h, tab_id));
  assert.ok((await devSent(h)).includes(`${tab_id} Runtime.enable`));
  assert.ok(text.includes("Console recording started now"), text);
  console.log(`console replay: ${text.includes("boot-log") ? "yes" : "no"}`);
  const again = textOf(await readCon(h, tab_id));
  assert.ok(!again.includes("Console recording started now"), again);
  assert.equal(countOf(await devSent(h), `${tab_id} Runtime.enable`), 1);
});

test("t_console_after_enable: logs and exceptions (with stack) after enabling are recorded", async () => {
  const h = await open();
  const tab_id = await openLogs(h);
  textOf(await readCon(h, tab_id));
  await clickLogButton(h, tab_id);
  await sleep(300);
  const text = textOf(await readCon(h, tab_id));
  assert.ok(text.includes("[log] clicked-log"), text);
  const lines = text.split("\n");
  const ex = lines.findIndex((l) => /^\d\d:\d\d:\d\d\.\d{3} \[exception\]/.test(l) && l.includes("late-boom"));
  assert.ok(ex >= 0, text);
  assert.ok(lines.slice(ex + 1).some((l) => /^ {4}at .+\(.+logs\.html:\d+:\d+\)$/.test(l)), text);
  // The stack is listed once, below the message, not also inside the message text.
  // (V8's own "at url:line:col" lines inside the description would show up as ":line:col (".)
  assert.ok(!lines.some((l) => /:\d+:\d+ \(/.test(l)), text);
});

test("t_console_filters: only_errors, pattern and invalid patterns", async () => {
  const h = await open();
  const tab_id = await openLogs(h);
  textOf(await readCon(h, tab_id));
  await clickLogButton(h, tab_id);
  await sleep(300);
  const errs = textOf(await readCon(h, tab_id, { only_errors: true }));
  assert.ok(!errs.includes("clicked-log"), errs);
  assert.ok(errs.includes("late-boom"), errs);
  const one = entries(textOf(await readCon(h, tab_id, { pattern: "CLICKED" })));
  assert.equal(one.length, 1, one.join("\n"));
  assert.equal(errOf(await readCon(h, tab_id, { pattern: "(" })).code, "invalid_pattern");
  for (const limit of [0, -1, 1.5, "2"]) assert.equal(errOf(await readCon(h, tab_id, { limit })).code, "invalid_args", `limit ${limit}`);
  assert.equal(errOf(await readCon(h, tab_id, { only_errors: "yes" })).code, "invalid_args");
  assert.equal(errOf(await readCon(h, tab_id, { pattern: 3 })).code, "invalid_args");
  assert.equal(errOf(await call(h.sw, "read_console_messages", {})).code, "invalid_args");
});

test("t_console_redact: credentials in logged URLs are redacted", async () => {
  const h = await open();
  const tab_id = await openLogs(h);
  textOf(await readCon(h, tab_id));
  await clickLogButton(h, tab_id);
  await sleep(300);
  const text = textOf(await readCon(h, tab_id));
  assert.ok(text.includes("token=REDACTED"), text);
  assert.ok(!text.includes("zzz"), text);
});

test("t_console_clear: clear empties the console buffer after this read", async () => {
  const h = await open();
  const tab_id = await openLogs(h);
  textOf(await readCon(h, tab_id));
  await clickLogButton(h, tab_id);
  await sleep(300);
  const first = textOf(await readCon(h, tab_id, { clear: true }));
  assert.ok(first.includes("clicked-log"), first);
  const second = textOf(await readCon(h, tab_id));
  assert.match(second, /^0 matching/, second);
});

test("t_console_stop_then_resume: a stopped tab is read from the buffer without attaching; the next action re-enables Runtime", async () => {
  const h = await open();
  const tab_id = await openLogs(h);
  textOf(await readCon(h, tab_id));
  await h.sw.evaluate(() => (globalThis as any).__webop.stopSession("test"));
  const paused = textOf(await readCon(h, tab_id));
  assert.ok(paused.includes("recording is paused"), paused);
  assert.equal(await isAttachedByUs(h, tab_id), false);
  assert.equal(countOf(await devSent(h), `${tab_id} Runtime.enable`), 1);
  textOf(await call(h.sw, "computer", { action: "screenshot", tab_id }));
  assert.equal(countOf(await devSent(h), `${tab_id} Runtime.enable`), 2);
  // Both readers learn about the gap, whichever reads first.
  const net = textOf(await readNet(h, tab_id));
  assert.ok(net.includes("nothing was recorded between"), net);
  const con = textOf(await readCon(h, tab_id));
  assert.ok(con.includes("nothing was recorded between"), con);
});

test("t_logs_moved_while_detached: a tab that left the site while detached shows nothing of the old site", async () => {
  const h = await open({ localhost: ["act"], "127.0.0.1": ["act"] });
  const tab_id = await openLogs(h);
  textOf(await readCon(h, tab_id));
  await clickLogButton(h, tab_id);
  await sleep(300);
  assert.ok(textOf(await readNet(h, tab_id)).includes("localhost"));
  assert.ok(textOf(await readCon(h, tab_id)).includes("clicked-log"));
  // Stop releases the debugger; then the tab moves to another (allowed) site while nothing of ours listens.
  await h.sw.evaluate(() => (globalThis as any).__webop.stopSession("test"));
  assert.equal(await isAttachedByUs(h, tab_id), false);
  const target = `${h.altUrl}/button.html`;
  await h.sw.evaluate(([id, u]) => chrome.tabs.update(id, { url: u }), [tab_id, target] as const);
  await waitForUrl(h, tab_id, target);
  const sentBefore = (await devSent(h)).length;
  const net = textOf(await readNet(h, tab_id));
  assert.match(net, /^0 matching/, net);
  assert.ok(!net.includes("localhost"), net);
  const con = textOf(await readCon(h, tab_id));
  assert.match(con, /^0 matching/, con);
  assert.ok(!con.includes("clicked-log") && !con.includes("localhost"), con);
  // Neither read attached or sent anything.
  assert.equal(await isAttachedByUs(h, tab_id), false);
  assert.equal((await devSent(h)).length, sentBefore);
});

test("t_logs_pending_unauthorized: while the tab is navigating to a site it may not read, both reads are refused", async () => {
  const h = await open();
  const tab_id = await openLogs(h);
  textOf(await readCon(h, tab_id));
  const slow = `${h.altUrl}/slow?ms=4000`;
  await h.sw.evaluate(([id, u]) => chrome.tabs.update(id, { url: u }), [tab_id, slow] as const);
  // Wait until the navigation is in flight (and its Document request has gone out), but not committed.
  for (let i = 0; i < 50; i++) {
    const t = await h.sw.evaluate((id) => chrome.tabs.get(id).then((x) => ({ url: x.url, pending: x.pendingUrl })), tab_id);
    if (t.pending === slow && t.url?.startsWith(h.baseUrl)) break;
    await sleep(50);
  }
  await sleep(300);
  const state = await h.sw.evaluate((id) => chrome.tabs.get(id).then((x) => ({ url: x.url, pending: x.pendingUrl })), tab_id);
  assert.ok(state.url?.startsWith(h.baseUrl) && state.pending === slow, JSON.stringify(state));
  for (const r of [await readNet(h, tab_id), await readCon(h, tab_id)]) {
    const e = errOf(r);
    assert.equal(e.code, "permission_required", e.message);
    assert.ok(!e.message.includes("slow"), e.message);
  }
});
