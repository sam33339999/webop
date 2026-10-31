import type { Level } from "@webop/core/grants";
import { screenshot } from "./capture.ts";

export interface AskRequest {
  session_id: string;
  client_name: string;
  site: string;
  level: Level;
  /** With a tab, the popup shows a screenshot of it. */
  tabId?: number;
  /** Intended click position in viewport CSS px. */
  marker?: { x: number; y: number };
}
export type Answer = "deny" | "once" | "always";

export const promptTimeouts = { askMs: 60_000 };

/** What the popup fetches. The image and marker are for the user's eyes only and never reach the agent. */
interface PromptView {
  client_name: string;
  site: string;
  level: Level;
  image?: string;
  marker?: { x: number; y: number };
}

interface Pending {
  view: PromptView;
  windowId?: number;
  finish(answer: Answer): void;
}

const inflight = new Map<string, Promise<Answer>>();
const byId = new Map<string, Pending>();

const promptUrl = (): string => chrome.runtime.getURL("prompt.html");

async function buildView(req: AskRequest): Promise<PromptView> {
  const view: PromptView = { client_name: req.client_name, site: req.site, level: req.level };
  if (req.tabId === undefined) return view;
  try {
    const { block, ctx } = await screenshot(req.tabId);
    if (block.type === "image") {
      view.image = `data:${block.mimeType};base64,${block.data}`;
      if (req.marker) {
        view.marker = {
          x: (req.marker.x * ctx.screenshotWidth) / ctx.viewportWidth,
          y: (req.marker.y * ctx.screenshotHeight) / ctx.viewportHeight,
        };
      }
    }
  } catch {
    // A failed screenshot must not block the question; ask without a picture.
  }
  return view;
}

/** Asks the user. Concurrent asks for the same (session, site, level) share one window and one answer. */
export function ask(req: AskRequest, signal?: AbortSignal): Promise<Answer> {
  const key = JSON.stringify([req.session_id, req.site, req.level]);
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = run(req, signal).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function run(req: AskRequest, signal?: AbortSignal): Promise<Answer> {
  if (signal?.aborted) return "deny";
  const id = crypto.randomUUID();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolve!: (a: Answer) => void;
  const result = new Promise<Answer>((r) => { resolve = r; });
  const entry: Pending = {
    view: { client_name: req.client_name, site: req.site, level: req.level },
    finish(answer) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      byId.delete(id);
      if (entry.windowId !== undefined) chrome.windows.remove(entry.windowId).catch(() => {});
      resolve(answer);
    },
  };
  const onAbort = (): void => entry.finish("deny");
  signal?.addEventListener("abort", onAbort);
  byId.set(id, entry);

  entry.view = await buildView(req);
  if (settled) return result;
  timer = setTimeout(() => entry.finish("deny"), promptTimeouts.askMs);
  try {
    const win = await chrome.windows.create({ url: `${promptUrl()}?id=${id}`, type: "popup", width: 480, height: 640, focused: true });
    entry.windowId = win?.id;
    // Settled while the window was opening (timeout, abort): close it now.
    if (settled && win?.id !== undefined) chrome.windows.remove(win.id).catch(() => {});
  } catch {
    entry.finish("deny");
  }
  return result;
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const entry of [...byId.values()]) if (entry.windowId === windowId) entry.finish("deny");
});

chrome.runtime.onMessage.addListener((msg: { type?: string; id?: string; answer?: string }, sender, sendResponse) => {
  // Only our own prompt page may read or answer; a content script carries the host page's URL.
  if (!sender.url?.startsWith(promptUrl())) return false;
  const entry = typeof msg?.id === "string" ? byId.get(msg.id) : undefined;
  if (msg?.type === "webop:prompt_get") {
    sendResponse(entry?.view ?? null);
  } else if (msg?.type === "webop:prompt_answer") {
    if (entry && (msg.answer === "once" || msg.answer === "always" || msg.answer === "deny")) entry.finish(msg.answer);
    sendResponse(null);
  }
  return false;
});
