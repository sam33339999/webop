import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
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
const allText = (r: R): string => ("content" in r ? r.content.map((b) => (b.type === "text" ? b.text : "")).join("\n") : "");

const promptPages = (h: Launched): Page[] => h.context.pages().filter((p) => p.url().includes("prompt.html"));
async function waitFor<T>(fn: () => T | undefined | false, what: string, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const popupOf = async (h: Launched) => {
  const popup = await waitFor(() => promptPages(h)[0], "prompt window");
  await popup.waitForFunction(() => (document.getElementById("site")?.textContent ?? "") !== "", undefined, { timeout: 10_000 });
  return popup;
};
const noPopup = async (h: Launched) => { await new Promise((r) => setTimeout(r, 400)); assert.equal(promptPages(h).length, 0, "no prompt expected"); };
const pageOf = (h: Launched, suffix: string) => waitFor(() => h.context.pages().find((p) => p.url().endsWith(suffix)), suffix);

// --- browser_get_page_text ---

test("t_page_text_main: main content only, with title and URL first", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/article.html`);
  const text = textOf(await call(h.sw, "get_page_text", { tab_id }));
  assert.ok(text.startsWith("Title: Article fixture\nURL: "), text);
  assert.match(text, /Main heading/);
  assert.match(text, /First paragraph of the main content\./);
  assert.match(text, /Second paragraph with bold words\./);
  for (const gone of ["SITE HEADER TEXT", "NAV LINK", "SITE FOOTER TEXT", "ASIDE TEXT"]) assert.ok(!text.includes(gone), `${gone} leaked:\n${text}`);
});

test("t_page_text_hidden_excluded: hidden elements and form values are not output", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/article.html`);
  const text = textOf(await call(h.sw, "get_page_text", { tab_id }));
  for (const gone of ["HIDDEN PARAGRAPH", "ALSO HIDDEN", "s3cret-pw", "typed value"]) assert.ok(!text.includes(gone), `${gone} leaked:\n${text}`);
});

test("t_page_text_truncate: max_chars caps the content and marks it", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/article.html`);
  const text = textOf(await call(h.sw, "get_page_text", { tab_id, max_chars: 50 }));
  const body = text.slice(text.indexOf("\n\n") + 2);
  assert.ok(body.endsWith("\n…(truncated)"), body);
  assert.ok(body.length - "\n…(truncated)".length <= 50, `content too long: ${body.length}`);
  assert.equal(errOf(await call(h.sw, "get_page_text", { tab_id, max_chars: 0 })).code, "invalid_args");
});

test("t_page_text_after_redirect: a tab that moved to an ungranted site gets permission_required and no text", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/redirect.html?to=${encodeURIComponent(`${h.altUrl}/article.html`)}`);
  for (let i = 0; i < 100 && !(await h.sw.evaluate((id) => chrome.tabs.get(id).then((t) => t.status === "complete" && (t.url ?? "").includes("127.0.0.1")), tab_id)); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = await call(h.sw, "get_page_text", { tab_id });
  const e = errOf(r);
  assert.equal(e.code, "permission_required");
  assert.ok(!e.message.includes("Main heading"));
  // The question is shown in the background, as for read_page.
  const popup = await popupOf(h);
  assert.equal(await popup.locator("#site").textContent(), "127.0.0.1");
});

test("t_page_text_denied_site: a denied site answers permission_denied without asking", async () => {
  const h = await open();
  await h.sw.evaluate(() => chrome.storage.local.set({ "webop.deny": ["127.0.0.1"] }));
  const tab_id = await openTab(h.sw, `${h.altUrl}/article.html`);
  assert.equal(errOf(await call(h.sw, "get_page_text", { tab_id })).code, "permission_denied");
  await noPopup(h);
});

// --- browser_form_input ---

/** read_page's interactive tree, and the ref of the element whose line matches `line`. */
async function refOf(h: Launched, tab_id: number, line: RegExp): Promise<string> {
  const tree = textOf(await call(h.sw, "read_page", { tab_id }));
  const hit = tree.split("\n").find((l) => line.test(l));
  const ref = hit && /\[(ref_\d+)\]/.exec(hit)?.[1];
  assert.ok(ref, `no line matching ${line} in:\n${tree}`);
  return ref;
}

test("t_form_input_text: sets a text field, fires input/change, returns a screenshot without submitting", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/form2.html`);
  const page = await pageOf(h, "/form2.html");
  const ref = await refOf(h, tab_id, /textbox "Name"/);
  const r = await call(h.sw, "form_input", { tab_id, ref, value: "Ada Lovelace" });
  assert.match(textOf(r), new RegExp(`^Set text input ${ref}\\.`));
  assert.ok("content" in r && r.content.some((b) => b.type === "image"), "no screenshot");
  assert.equal(await page.locator("#name").inputValue(), "Ada Lovelace");
  const events = await page.evaluate(() => (window as any).events);
  assert.ok(events.input >= 1 && events.change >= 1, JSON.stringify(events));
  assert.equal(await page.title(), "form2");
});

test("t_form_input_select_by_label: an option's visible text selects it", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/form2.html`);
  const page = await pageOf(h, "/form2.html");
  const ref = await refOf(h, tab_id, /select "Color/);
  textOf(await call(h.sw, "form_input", { tab_id, ref, value: "Green" }));
  assert.equal(await page.locator("#color").inputValue(), "g");
  textOf(await call(h.sw, "form_input", { tab_id, ref, value: "b" }));
  assert.equal(await page.locator("#color").inputValue(), "b");
  assert.equal(errOf(await call(h.sw, "form_input", { tab_id, ref, value: "Purple" })).code, "invalid_args");
});

test("t_form_input_checkbox: booleans only", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/form2.html`);
  const page = await pageOf(h, "/form2.html");
  const ref = await refOf(h, tab_id, /checkbox "Agree"/);
  textOf(await call(h.sw, "form_input", { tab_id, ref, value: true }));
  assert.equal(await page.locator("#agree").isChecked(), true);
  const e = errOf(await call(h.sw, "form_input", { tab_id, ref, value: "yes" }));
  assert.equal(e.code, "invalid_args");
  assert.match(e.message, /^Not performed/);
  const radio = await refOf(h, tab_id, /radio "Large"/);
  textOf(await call(h.sw, "form_input", { tab_id, ref: radio, value: true }));
  assert.equal(await page.locator("#large").isChecked(), true);
});

test("t_form_input_password_not_echoed: the value never appears in the result", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/form2.html`);
  const page = await pageOf(h, "/form2.html");
  const ref = await refOf(h, tab_id, /textbox "Password"/);
  const r = await call(h.sw, "form_input", { tab_id, ref, value: "s3cret" });
  assert.ok("content" in r, JSON.stringify(r));
  assert.ok(!allText(r).includes("s3cret"), allText(r));
  assert.equal(await page.locator("#pw").inputValue(), "s3cret");
});

test("t_form_input_unsupported: read-only, non-field and stale refs are refused", async () => {
  const h = await open();
  const tab_id = await openTab(h.sw, `${h.baseUrl}/form2.html`);
  const locked = await refOf(h, tab_id, /textbox "Locked"/);
  assert.equal(errOf(await call(h.sw, "form_input", { tab_id, ref: locked, value: "x" })).code, "invalid_args");
  const plain = await refOf(h, tab_id, /textbox "Plain"/);
  assert.equal(errOf(await call(h.sw, "form_input", { tab_id, ref: plain, value: "x" })).code, "invalid_args");
  assert.equal(errOf(await call(h.sw, "form_input", { tab_id, ref: "ref_99999", value: "x" })).code, "stale_ref");
  assert.equal(errOf(await call(h.sw, "form_input", { tab_id, ref: locked, value: { a: 1 } })).code, "invalid_args");
});

test("t_form_input_unauthorized: an ungranted site asks for act; declining leaves the field unchanged", async () => {
  const h = await open({ localhost: ["act"], "127.0.0.1": ["read"] });
  const tab_id = await openTab(h.sw, `${h.altUrl}/form2.html`);
  const page = await pageOf(h, "/form2.html");
  const ref = await refOf(h, tab_id, /textbox "Name"/);
  const r = call(h.sw, "form_input", { tab_id, ref, value: "nope" });
  const popup = await popupOf(h);
  assert.equal(await popup.locator("#level").textContent(), "act");
  await popup.getByRole("button", { name: "拒絕" }).click();
  const e = errOf(await r);
  assert.equal(e.code, "permission_denied");
  assert.match(e.message, /no field was changed/);
  assert.equal(await page.locator("#name").inputValue(), "");
});
