import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import { launch, openTab, type Launched } from "./harness.ts";

const opened: Launched[] = [];
async function open() {
  const h = await launch();
  opened.push(h);
  return h;
}
after(async () => { for (const h of opened) await h.close(); });

type Req = { session_id: string; client_name: string; site: string; level: string; tabId?: number; marker?: { x: number; y: number } };
const baseReq = (o: Partial<Req> = {}): Req => ({ session_id: "s1", client_name: "claude-test", site: "localhost", level: "act", ...o });

/** Starts ask() in the SW; the returned promise settles with the Answer. */
function ask(h: Launched, req: Req): Promise<string> {
  return h.sw.evaluate((r) => (globalThis as any).__webop.ask(r), req);
}

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
const popupOf = (h: Launched) => waitFor(() => promptPages(h)[0], "prompt window");

test("t_prompt_allow_once: popup shows client/site/level; 本次允許 resolves once", async () => {
  const h = await open();
  const answer = ask(h, baseReq());
  const popup = await popupOf(h);
  await popup.waitForLoadState("domcontentloaded");
  await popup.locator("#client").filter({ hasText: "claude-test" }).waitFor();
  assert.equal(await popup.locator("#site").textContent(), "localhost");
  assert.equal(await popup.locator("#level").textContent(), "act");
  await popup.getByRole("button", { name: "本次允許" }).click();
  assert.equal(await answer, "once");
  await waitFor(() => promptPages(h).length === 0, "popup closed");
});

test("t_prompt_always: 永久允許 resolves always", async () => {
  const h = await open();
  const answer = ask(h, baseReq());
  const popup = await popupOf(h);
  await popup.getByRole("button", { name: "永久允許" }).click();
  assert.equal(await answer, "always");
});

test("t_prompt_deny: 拒絕 resolves deny", async () => {
  const h = await open();
  const answer = ask(h, baseReq());
  const popup = await popupOf(h);
  await popup.getByRole("button", { name: "拒絕" }).click();
  assert.equal(await answer, "deny");
});

test("t_prompt_timeout: no answer within askMs resolves deny and closes the window", async () => {
  const h = await open();
  await h.sw.evaluate(() => { (globalThis as any).__webop.promptTimeouts.askMs = 500; });
  const answer = ask(h, baseReq());
  await popupOf(h);
  assert.equal(await answer, "deny");
  await waitFor(() => promptPages(h).length === 0, "popup closed after timeout");
});

test("t_prompt_window_closed: closing the popup resolves deny", async () => {
  const h = await open();
  const answer = ask(h, baseReq());
  const popup = await popupOf(h);
  await popup.close();
  assert.equal(await answer, "deny");
});

test("t_dedupe: three concurrent asks share one window and one answer", async () => {
  const h = await open();
  const answers = [ask(h, baseReq()), ask(h, baseReq()), ask(h, baseReq())];
  const popup = await popupOf(h);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(promptPages(h).length, 1);
  await popup.getByRole("button", { name: "本次允許" }).click();
  assert.deepEqual(await Promise.all(answers), ["once", "once", "once"]);
  // Another session is a different question.
  const other = ask(h, baseReq({ session_id: "s2" }));
  const popup2 = await popupOf(h);
  await popup2.getByRole("button", { name: "拒絕" }).click();
  assert.equal(await other, "deny");
});

test("t_answer_sender_checked: an answer from a page's content-script context is ignored", async () => {
  const h = await open();
  const tabId = await openTab(h.sw, `${h.baseUrl}/`);
  const answer = ask(h, baseReq());
  const popup = await popupOf(h);
  const id = new URL(popup.url()).searchParams.get("id");
  assert.ok(id);
  // Isolated world = content-script context: sender.url is the web page's URL.
  const got = await h.sw.evaluate(async ([t, i]) => {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: t as number },
      world: "ISOLATED",
      func: async (pid: string) => {
        const view = await chrome.runtime.sendMessage({ type: "webop:prompt_get", id: pid });
        await chrome.runtime.sendMessage({ type: "webop:prompt_answer", id: pid, answer: "always" });
        return view ?? null;
      },
      args: [i as string],
    });
    return r.result;
  }, [tabId, id] as const);
  assert.equal(got, null, "prompt_get from a content script gets no data");
  const state = await Promise.race([answer, new Promise((r) => setTimeout(() => r("pending"), 800))]);
  assert.equal(state, "pending");
  assert.equal(promptPages(h).length, 1);
  await popup.getByRole("button", { name: "拒絕" }).click();
  assert.equal(await answer, "deny");
});

test("popup shows the screenshot with the marker converted to image pixels", async () => {
  const h = await open();
  const tabId = await openTab(h.sw, `${h.baseUrl}/`);
  const answer = ask(h, baseReq({ tabId, marker: { x: 100, y: 50 } }));
  const popup = await popupOf(h);
  await popup.locator("#marker:not([hidden])").waitFor();
  assert.ok(await popup.locator("#img").evaluate((i: HTMLImageElement) => i.naturalWidth > 0));
  const ctx = await h.sw.evaluate((t) => (globalThis as any).__webop.getContext(t), tabId);
  const left = await popup.locator("#marker").evaluate((m: HTMLElement) => m.style.left);
  assert.equal(parseFloat(left).toFixed(2), (((100 * ctx.screenshotWidth) / ctx.viewportWidth / ctx.screenshotWidth) * 100).toFixed(2));
  await popup.getByRole("button", { name: "拒絕" }).click();
  assert.equal(await answer, "deny");
});

test("a prompt page cannot answer another prompt's id", async () => {
  const h = await open();
  const a = ask(h, baseReq({ session_id: "A" }));
  const popupA = await popupOf(h);
  const idA = new URL(popupA.url()).searchParams.get("id");
  const b = ask(h, baseReq({ session_id: "B" }));
  const popupB = await waitFor(() => promptPages(h).find((p) => p !== popupA), "second prompt window");
  const idB = new URL(popupB.url()).searchParams.get("id");
  assert.notEqual(idA, idB);
  const view = await popupA.evaluate((i) => chrome.runtime.sendMessage({ type: "webop:prompt_get", id: i }), idB);
  assert.equal(view ?? null, null, "prompt_get for a foreign id returns nothing");
  await popupA.evaluate((i) => chrome.runtime.sendMessage({ type: "webop:prompt_answer", id: i, answer: "always" }), idB);
  assert.equal(await Promise.race([b, new Promise((r) => setTimeout(() => r("pending"), 600))]), "pending");
  await popupB.getByRole("button", { name: "拒絕" }).click();
  assert.equal(await b, "deny");
  await popupA.getByRole("button", { name: "拒絕" }).click();
  assert.equal(await a, "deny");
});

/** ask() with a controller kept in the SW so the test can abort it later. */
function askAbortable(h: Launched, name: string, req: Req): Promise<string> {
  return h.sw.evaluate(([n, r]) => {
    const g = globalThis as any;
    g.__ac ??= {};
    g.__ac[n] = new AbortController();
    return g.__webop.ask(r, g.__ac[n].signal);
  }, [name, req] as const);
}
const abort = (h: Launched, name: string) => h.sw.evaluate((n) => (globalThis as any).__ac[n].abort(), name);

test("shared prompt closes only when every joined caller has aborted", async () => {
  const h = await open();
  const first = askAbortable(h, "c1", baseReq());
  const second = askAbortable(h, "c2", baseReq());
  const popup = await popupOf(h);
  await abort(h, "c1");
  assert.equal(await first, "deny", "aborted caller is denied at once");
  assert.equal(await Promise.race([second, new Promise((r) => setTimeout(() => r("pending"), 600))]), "pending");
  assert.equal(promptPages(h).length, 1, "window stays open for the remaining caller");
  await abort(h, "c2");
  assert.equal(await second, "deny");
  await waitFor(() => popup.isClosed(), "popup closed after all aborted");
});

test("a caller joining after the prompt settled gets a fresh prompt", async () => {
  const h = await open();
  const first = ask(h, baseReq());
  const popup = await popupOf(h);
  await popup.getByRole("button", { name: "本次允許" }).click();
  assert.equal(await first, "once");
  const again = ask(h, baseReq());
  const popup2 = await popupOf(h);
  await popup2.getByRole("button", { name: "永久允許" }).click();
  assert.equal(await again, "always");
});
