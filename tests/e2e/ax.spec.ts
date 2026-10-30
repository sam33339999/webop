import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import { call, launch, openTab, type Launched } from "./harness.ts";

const opened: Launched[] = [];
async function open() {
  const h = await launch();
  opened.push(h);
  return h;
}
after(async () => { for (const h of opened) await h.close(); });

async function setup() {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/ax.html`);
  const page = h.context.pages().find((p) => p.url() === `${h.baseUrl}/ax.html`) as Page;
  assert.ok(page);
  return { h, tab_id, page };
}

async function readText(h: Launched, args: object): Promise<string> {
  const r = await call(h.sw, "read_page", args);
  assert.ok("content" in r, "error" in r ? r.error.message : "");
  const block = r.content[0];
  assert.equal(block.type, "text");
  return block.type === "text" ? block.text : "";
}

function refOf(text: string, pattern: RegExp): string {
  const m = text.match(pattern);
  assert.ok(m, `pattern ${pattern} in:\n${text}`);
  return m[1];
}

test("read_page lists button with ref", async () => {
  const { h, tab_id } = await setup();
  const text = await readText(h, { tab_id });
  assert.match(text, /button "Submit" \[ref_\d+\]/);
  assert.match(text, /link "Go elsewhere" \[ref_\d+\] href="\/other.html"/);
  assert.match(text, /Lorem/);
});

test("select options are expanded", async () => {
  const { h, tab_id } = await setup();
  const text = await readText(h, { tab_id });
  assert.match(text, /option "Green" .*\(selected\)/);
  assert.match(text, /option "Red" .*value="r"/);
});

test("password value redacted", async () => {
  const { h, tab_id } = await setup();
  const text = await readText(h, { tab_id });
  assert.ok(!text.includes("hunter2"));
  assert.ok(text.includes("[value redacted]"));
});

test("interactive filter drops plain text", async () => {
  const { h, tab_id } = await setup();
  const text = await readText(h, { tab_id, filter: "interactive" });
  assert.ok(!text.includes("Lorem"));
  assert.match(text, /button "Submit" \[ref_\d+\]/);
});

test("max_chars truncates", async () => {
  const { h, tab_id } = await setup();
  const text = await readText(h, { tab_id, max_chars: 200 });
  assert.ok(text.length <= 260, `length ${text.length}`);
  assert.match(text, /truncated/);
});

test("ref_id limits output to a subtree", async () => {
  const { h, tab_id } = await setup();
  const full = await readText(h, { tab_id });
  const ref = refOf(full, /select "Color" \[(ref_\d+)\]/);
  const text = await readText(h, { tab_id, ref_id: ref });
  assert.match(text, /option "Red"/);
  assert.ok(!text.includes("Submit"));
});

test("left_click by ref", async () => {
  const { h, tab_id, page } = await setup();
  const ref = refOf(await readText(h, { tab_id }), /button "Submit" \[(ref_\d+)\]/);
  const r = await call(h.sw, "computer", { action: "left_click", tab_id, ref });
  assert.ok("content" in r, "error" in r ? r.error.message : "");
  assert.ok(r.content.some((b) => b.type === "image"));
  assert.equal(await page.title(), "clicked:true");
});

test("ref below fold scrolls into view then clicks", async () => {
  const { h, tab_id, page } = await setup();
  const ref = refOf(await readText(h, { tab_id }), /button "Far away" \[(ref_\d+)\]/);
  assert.equal(await page.evaluate(() => scrollY), 0);
  const r = await call(h.sw, "computer", { action: "left_click", tab_id, ref });
  assert.ok("content" in r, "error" in r ? r.error.message : "");
  assert.equal(await page.title(), "far:true");
  assert.ok((await page.evaluate(() => scrollY)) > 1000);
});

test("scroll_to scrolls without clicking", async () => {
  const { h, tab_id, page } = await setup();
  const ref = refOf(await readText(h, { tab_id }), /button "Far away" \[(ref_\d+)\]/);
  const r = await call(h.sw, "computer", { action: "scroll_to", tab_id, ref });
  assert.ok("content" in r, "error" in r ? r.error.message : "");
  assert.ok(r.content.some((b) => b.type === "image"));
  assert.ok((await page.evaluate(() => scrollY)) > 1000);
  assert.equal(await page.title(), "ax");
});

test("stale ref after navigation", async () => {
  const { h, tab_id, page } = await setup();
  const ref = refOf(await readText(h, { tab_id }), /button "Submit" \[(ref_\d+)\]/);
  await page.reload();
  const r = await call(h.sw, "computer", { action: "left_click", tab_id, ref });
  assert.ok("error" in r);
  assert.equal(r.error.code, "stale_ref");
});

test("ref and coordinate both -> invalid_args", async () => {
  const { h, tab_id } = await setup();
  const ref = refOf(await readText(h, { tab_id }), /button "Submit" \[(ref_\d+)\]/);
  const r = await call(h.sw, "computer", { action: "left_click", tab_id, ref, coordinate: [10, 10] });
  assert.ok("error" in r);
  assert.equal(r.error.code, "invalid_args");
  const r2 = await call(h.sw, "computer", { action: "left_click", tab_id });
  assert.ok("error" in r2);
  assert.equal(r2.error.code, "invalid_args");
});
