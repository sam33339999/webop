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
