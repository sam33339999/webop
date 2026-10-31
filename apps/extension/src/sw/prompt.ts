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

/** One open question, shared by every caller that asked the same (session, site, level) while it was open. */
interface Shared {
  id: string;
  view: PromptView;
  windowId?: number;
  settled: boolean;
  callers: number;
  aborted: number;
  promise: Promise<Answer>;
  finish(answer: Answer): void;
}

const inflight = new Map<string, Shared>();
const byId = new Map<string, Shared>();

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

function open(req: AskRequest, key: string): Shared {
  const id = crypto.randomUUID();
  let resolve!: (a: Answer) => void;
  const promise = new Promise<Answer>((r) => { resolve = r; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const shared: Shared = {
    id,
    view: { client_name: req.client_name, site: req.site, level: req.level },
    settled: false,
    callers: 0,
    aborted: 0,
    promise,
    finish(answer) {
      if (shared.settled) return;
      shared.settled = true;
      clearTimeout(timer);
      byId.delete(id);
      if (inflight.get(key) === shared) inflight.delete(key);
      if (shared.windowId !== undefined) chrome.windows.remove(shared.windowId).catch(() => {});
      resolve(answer);
    },
  };
  byId.set(id, shared);
  inflight.set(key, shared);
  // The deadline covers the screenshot too, so a slow capture cannot stretch the wait.
  timer = setTimeout(() => shared.finish("deny"), promptTimeouts.askMs);
  void (async () => {
    shared.view = await buildView(req);
    if (shared.settled) return;
    try {
      const win = await chrome.windows.create({ url: `${promptUrl()}?id=${id}`, type: "popup", width: 480, height: 640, focused: true });
      shared.windowId = win?.id;
      // Settled while the window was opening (timeout, abort): close it now.
      if (shared.settled && win?.id !== undefined) chrome.windows.remove(win.id).catch(() => {});
    } catch {
      shared.finish("deny");
    }
  })();
  return shared;
}

/**
 * Asks the user. Concurrent asks for the same (session, site, level) share one window and one answer.
 * Each caller's own `signal` denies that caller at once; the shared window closes only when every joined caller has aborted.
 */
export function ask(req: AskRequest, signal?: AbortSignal): Promise<Answer> {
  if (signal?.aborted) return Promise.resolve("deny");
  const key = JSON.stringify([req.session_id, req.site, req.level]);
  const found = inflight.get(key);
  const shared = found && !found.settled ? found : open(req, key);
  shared.callers++;
  if (!signal) return shared.promise;
  return new Promise<Answer>((resolve) => {
    const onAbort = (): void => {
      shared.aborted++;
      resolve("deny");
      if (shared.aborted >= shared.callers) shared.finish("deny");
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void shared.promise.then((a) => {
      signal.removeEventListener("abort", onAbort);
      resolve(a);
    });
  });
}

/** Windows left over from a previous service worker instance can no longer be answered; close them. */
async function closeOrphans(): Promise<void> {
  const wins = await chrome.windows.getAll({ populate: true });
  for (const w of wins) {
    if (w.id !== undefined && w.tabs?.some((t) => (t.url ?? t.pendingUrl ?? "").startsWith(promptUrl()))) {
      chrome.windows.remove(w.id).catch(() => {});
    }
  }
}
closeOrphans().catch(() => {});

chrome.windows.onRemoved.addListener((windowId) => {
  for (const entry of [...byId.values()]) if (entry.windowId === windowId) entry.finish("deny");
});

chrome.runtime.onMessage.addListener((msg: { type?: string; id?: string; answer?: string }, sender, sendResponse) => {
  // Only our own prompt page may read or answer; a content script carries the host page's URL.
  if (!sender.url?.startsWith(promptUrl())) return false;
  if (msg?.type !== "webop:prompt_get" && msg?.type !== "webop:prompt_answer") return false;
  const entry = typeof msg.id === "string" ? byId.get(msg.id) : undefined;
  // A prompt page may only act on the question that opened its own window.
  const bound = entry !== undefined && entry.windowId !== undefined && sender.tab?.windowId === entry.windowId;
  if (msg.type === "webop:prompt_get") {
    sendResponse(bound ? entry.view : null);
  } else {
    if (bound && (msg.answer === "once" || msg.answer === "always" || msg.answer === "deny")) entry.finish(msg.answer);
    sendResponse(null);
  }
  return false;
});
