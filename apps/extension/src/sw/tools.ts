import type { ContentBlock, ToolCall, ToolResult } from "@webop/core/protocol";
import { CdpError, send, timeouts } from "./cdp.ts";
import { toViewport } from "@webop/core/coords";
import { getContext, screenshot } from "./capture.ts";
import { click, drag, hover, pressKeys, scroll, typeText } from "./input.ts";
import { assertLive, assertOwned, createTab, ensureSession, listTabs } from "./sessions.ts";
import { siteOf } from "@webop/core/domain";
import { checkSite, isSiteAllowed } from "./permissions.ts";

type Outcome = { content: ContentBlock[] };

function invalid(message: string): never {
  throw new CdpError("invalid_args", message);
}

function tabIdOf(args: Record<string, unknown>): number {
  const id = args.tab_id;
  if (typeof id !== "number" || !Number.isInteger(id)) invalid("tab_id must be an integer.");
  return id;
}

function pointArg(args: Record<string, unknown>, name: string): [number, number] {
  const v = args[name];
  if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== "number" || typeof v[1] !== "number") {
    invalid(`${name} must be [x, y].`);
  }
  return [v[0], v[1]];
}

function textArg(args: Record<string, unknown>): string {
  if (typeof args.text !== "string" || args.text === "") invalid("text must be a non-empty string.");
  return args.text;
}

/** Screenshot-frame coordinate -> viewport CSS px, using the context of the last screenshot of this tab. */
function toViewportPoint(tabId: number, point: [number, number]): [number, number] {
  const ctx = getContext(tabId);
  if (!ctx) invalid("No screenshot context for this tab; take a screenshot first.");
  const r = toViewport(point[0], point[1], ctx);
  if ("oobError" in r) throw new CdpError("oob", r.oobError);
  return r.viewport;
}

const CONTENT_TIMEOUT_MS = 5000;

/** Sends a message to the top-frame content script; an unreachable script becomes `internal`, never a hang. */
async function askContent<T>(tabId: number, msg: object): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), CONTENT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }) as Promise<T>, timeout]);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new CdpError("internal", `Page content script not reachable (${why}). The page may be protected or still loading; reload the tab and retry.`);
  } finally {
    clearTimeout(timer);
  }
}

type Point = { x: number; y: number };

async function refPoint(tabId: number, ref: unknown): Promise<[number, number]> {
  if (typeof ref !== "string" || ref === "") invalid("ref must be a non-empty string.");
  const r = await askContent<Point | { error: "stale_ref"; message?: string } | undefined>(tabId, { type: "webop:ref_point", ref });
  if (!r) throw new CdpError("internal", "Page content script returned no reply.");
  if ("error" in r) throw new CdpError("stale_ref", `${ref}: ${r.message ?? "no longer exists"}; call read_page again to get fresh refs.`);
  return [r.x, r.y];
}

/** A target is either a screenshot-frame coordinate or an element ref, never both and never neither. */
async function targetArg(tabId: number, args: Record<string, unknown>, coordName: string, refName: string): Promise<[number, number]> {
  const hasCoord = args[coordName] !== undefined;
  const hasRef = args[refName] !== undefined;
  if (hasCoord === hasRef) invalid(`Provide exactly one of ${coordName} or ${refName}.`);
  if (hasRef) return refPoint(tabId, args[refName]);
  return toViewportPoint(tabId, pointArg(args, coordName));
}

/** Input must never reach a frame we cannot attribute to the tab's own site (e.g. an embedded login or payment widget). */
async function assertNotCrossSiteFrame(tabId: number, point?: [number, number]): Promise<void> {
  const r = await askContent<{ ok: true } | { ok: false; src: string } | undefined>(tabId, { type: "webop:frame_check", x: point?.[0], y: point?.[1] });
  if (!r) throw new CdpError("internal", "Page content script returned no reply.");
  if (r.ok) return;
  const site = r.src ? siteOf(r.src) : null;
  throw new CdpError("permission_denied", `target is inside a cross-site frame (${site ?? "unknown"}); webop only acts on the tab's own site.`);
}

async function guardedTarget(tabId: number, args: Record<string, unknown>, coordName: string, refName: string): Promise<[number, number]> {
  const point = await targetArg(tabId, args, coordName, refName);
  await assertNotCrossSiteFrame(tabId, point);
  return point;
}

async function perform(action: string, tabId: number, args: Record<string, unknown>): Promise<void> {
  const target = () => guardedTarget(tabId, args, "coordinate", "ref");
  switch (action) {
    case "left_click": return click(tabId, ...(await target()));
    case "right_click": return click(tabId, ...(await target()), { button: "right" });
    case "double_click": return click(tabId, ...(await target()), { count: 2 });
    case "hover": return hover(tabId, ...(await target()));
    case "scroll_to": {
      if (args.ref === undefined) invalid("scroll_to requires ref.");
      await refPoint(tabId, args.ref);
      return;
    }
    case "left_click_drag": {
      const from = await guardedTarget(tabId, args, "start_coordinate", "start_ref");
      const to = await target();
      return drag(tabId, from, to);
    }
    case "type": {
      const text = textArg(args);
      await assertNotCrossSiteFrame(tabId);
      return typeText(tabId, text);
    }
    case "key": {
      const combo = textArg(args);
      await assertNotCrossSiteFrame(tabId);
      try {
        return await pressKeys(tabId, combo);
      } catch (e) {
        if (e instanceof CdpError) throw e;
        invalid(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    case "scroll": {
      const [x, y] = await target();
      const dir = args.scroll_direction;
      if (dir !== "up" && dir !== "down" && dir !== "left" && dir !== "right") invalid("scroll_direction must be up, down, left or right.");
      const amount = args.scroll_amount ?? 3;
      if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) invalid("scroll_amount must be a positive number.");
      return scroll(tabId, x, y, dir, amount);
    }
    default:
      invalid(`Unknown computer action: ${action}`);
  }
}

/** Nothing state-changing may start once the call's deadline has passed: the caller has already been told it failed. */
function assertBeforeDeadline(deadline: number): void {
  if (Date.now() > deadline) {
    throw new CdpError("timeout", "Not performed: the tab was busy with an earlier call past this call's deadline.");
  }
}

const NAVIGATE_TIMEOUT_MS = 30000;

/** Resolves once the tab has finished loading what `start` kicked off; rejects with `timeout` after 30 s. */
async function afterLoad(tabId: number, start: () => Promise<unknown>): Promise<void> {
  let sawLoading = false;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const onUpdated = (id: number, info: { status?: string }) => {
    if (id !== tabId) return;
    if (info.status === "loading") sawLoading = true;
    if (info.status === "complete" && sawLoading) finish();
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
  const startedAt = Date.now();
  // Same-document navigations never emit "loading"; fall back to the tab's own status after a short grace period.
  const poll = setInterval(() => {
    if (!sawLoading && Date.now() - startedAt < 500) return;
    chrome.tabs.get(tabId).then((t) => { if (t.status === "complete") finish(); }, finish);
  }, 100);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CdpError("timeout", `Page did not finish loading within ${NAVIGATE_TIMEOUT_MS / 1000}s.`)), NAVIGATE_TIMEOUT_MS);
  });
  try {
    await start();
    await Promise.race([done, timeout]);
  } finally {
    clearTimeout(timer);
    clearInterval(poll);
    chrome.tabs.onUpdated.removeListener(onUpdated);
  }
}

async function currentUrl(tabId: number): Promise<string> {
  try {
    return (await chrome.tabs.get(tabId)).url ?? "";
  } catch {
    throw new CdpError("tab_not_in_session", `Tab ${tabId} does not exist.`);
  }
}

/** Ownership and allowlist gate for every tool that touches page content; runs before anything is read or sent. */
async function authorize(session_id: string, tabId: number): Promise<void> {
  await assertOwned(session_id, tabId);
  await checkSite(await currentUrl(tabId));
}

function urlArg(args: Record<string, unknown>): string {
  if (typeof args.url !== "string" || args.url === "") invalid("url must be a non-empty string.");
  return args.url;
}

/** Resolves the history entry through CDP and checks its site BEFORE loading it. */
async function goHistory(tabId: number, dir: "back" | "forward"): Promise<void> {
  const h = await send<{ currentIndex: number; entries: { id: number; url: string }[] }>(tabId, "Page.getNavigationHistory");
  const entry = h.entries[h.currentIndex + (dir === "back" ? -1 : 1)];
  if (!entry) throw new CdpError("invalid_args", `Cannot go ${dir}: no such history entry.`);
  await checkSite(entry.url);
  await send(tabId, "Page.navigateToHistoryEntry", { entryId: entry.id });
}

/** Re-checks the tab's current site after content was produced; denial withholds the content. */
async function recheck(tabId: number, performed: boolean): Promise<void> {
  const url = await currentUrl(tabId);
  try {
    await checkSite(url);
  } catch (e) {
    if (!(e instanceof CdpError) || e.code !== "permission_denied") throw e;
    const what = performed ? "The action WAS performed, but the" : "The";
    throw new CdpError("permission_denied", `${what} tab is now on a site that is not allowed (${siteOf(url) ?? "non-web page"}); no content is returned. ${e.message}`);
  }
}

/** Gives a navigation triggered by an action time to start, then waits for it to settle. */
async function settle(tabId: number): Promise<void> {
  await new Promise((r) => setTimeout(r, 150));
  for (let i = 0; i < 50; i++) {
    const t = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!t || t.status !== "loading") return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function navigate(session_id: string, args: Record<string, unknown>, deadline: number): Promise<Outcome> {
  const tabId = tabIdOf(args);
  const target = urlArg(args);
  await assertOwned(session_id, tabId);
  const history = target === "back" || target === "forward";
  if (!history) await checkSite(target);
  assertBeforeDeadline(deadline);
  await afterLoad(tabId, async () => {
    if (!history) {
      await chrome.tabs.update(tabId, { url: target });
    } else {
      await goHistory(tabId, target);
    }
  });
  const final = await currentUrl(tabId);
  await checkSite(final);
  return { content: [{ type: "text", text: `Navigated to ${final}` }] };
}

const tabQueues = new Map<number, Promise<void>>();

/** Runs `fn` after every earlier call on the same tab has finished (FIFO), so overlay hiding, captures and input sequences never interleave. */
async function withTab<T>(tabId: number, deadline: number, fn: () => Promise<T>): Promise<T> {
  const prev = tabQueues.get(tabId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const tail = prev.then(() => mine);
  tabQueues.set(tabId, tail);
  await prev;
  try {
    assertBeforeDeadline(deadline);
    return await fn();
  } finally {
    release();
    if (tabQueues.get(tabId) === tail) tabQueues.delete(tabId);
  }
}

async function run(call: ToolCall, deadline: number): Promise<Outcome> {
  await ensureSession(call.session_id);
  if (call.tool === "tabs_list") {
    // A tab can wander off the allowlist (redirect, user); never leak its title or URL.
    const tabs = await Promise.all((await listTabs(call.session_id)).map(async (t) =>
      (await isSiteAllowed(t.url)) ? t : { tab_id: t.tab_id, title: "", url: "(site not allowed)" }));
    return { content: [{ type: "text", text: JSON.stringify(tabs) }] };
  }
  if (call.tool === "tabs_create") {
    const url = urlArg(call.args);
    await checkSite(url);
    const tab = await createTab(call.session_id, url);
    const tab_id = tab.id as number;
    await afterLoad(tab_id, async () => {});
    try {
      await checkSite(await currentUrl(tab_id));
    } catch (e) {
      await chrome.tabs.remove(tab_id).catch(() => {});
      throw e;
    }
    return { content: [{ type: "text", text: JSON.stringify({ tab_id, url: await currentUrl(tab_id) }) }] };
  }
  if (call.tool === "tabs_close") {
    const tabId = tabIdOf(call.args);
    // Deliberately outside withTab: closing must work while the page is blocked; queued calls then fail on their own (tab gone).
    await assertOwned(call.session_id, tabId);
    await chrome.tabs.remove(tabId);
    return { content: [{ type: "text", text: `Closed tab ${tabId}` }] };
  }
  if (call.tool === "navigate") {
    const tabId = tabIdOf(call.args);
    return withTab(tabId, deadline, () => navigate(call.session_id, call.args, deadline));
  }
  if (call.tool === "computer") {
    const action = String(call.args.action);
    const tabId = tabIdOf(call.args);
    return withTab(tabId, deadline, async () => {
      await authorize(call.session_id, tabId);
      const performed = action !== "screenshot";
      if (performed) {
        assertBeforeDeadline(deadline);
        await perform(action, tabId, call.args);
        await settle(tabId);
      }
      await assertLive(call.session_id);
      await recheck(tabId, performed);
      const { block } = await screenshot(tabId);
      await recheck(tabId, performed);
      return { content: [block] };
    });
  }
  if (call.tool === "read_page") {
    const tabId = tabIdOf(call.args);
    return withTab(tabId, deadline, () => readPage(call));
  }
  invalid(`Unknown tool: ${String(call.tool)}`);
}

async function readPage(call: ToolCall): Promise<Outcome> {
  const tabId = tabIdOf(call.args);
  await authorize(call.session_id, tabId);
  const { filter, ref_id, max_chars } = call.args;
  if (filter !== undefined && filter !== "interactive") invalid('filter must be "interactive".');
  if (ref_id !== undefined && typeof ref_id !== "string") invalid("ref_id must be a string.");
  if (max_chars !== undefined && (typeof max_chars !== "number" || !Number.isFinite(max_chars) || max_chars <= 0)) invalid("max_chars must be a positive number.");
  const key = `webop.refBase.${tabId}`;
  const stored = (await chrome.storage.session.get(key))[key];
  const ref_base = typeof stored === "number" ? stored : 0;
  const r = await askContent<{ text: string; counter: number } | { error: "stale_ref" } | undefined>(tabId, { type: "webop:read_page", filter, ref_id, max_chars: max_chars ?? 50000, ref_base });
  if (!r) throw new CdpError("internal", "Page content script returned no reply.");
  if ("error" in r) throw new CdpError("stale_ref", `${String(ref_id)} no longer exists; call read_page again to get fresh refs.`);
  await chrome.storage.session.set({ [key]: Math.max(ref_base, r.counter) });
  await assertLive(call.session_id);
  await recheck(tabId, false);
  return { content: [{ type: "text", text: r.text }] };
}

export async function dispatch(call: ToolCall): Promise<ToolResult> {
  const base = { id: call.id, session_id: call.session_id };
  const deadline = Date.now() + timeouts.callDeadlineMs;
  try {
    return { ...base, ...(await run(call, deadline)) };
  } catch (e) {
    if (e instanceof CdpError) return { ...base, error: { code: e.code, message: e.message } };
    return { ...base, error: { code: "internal", message: e instanceof Error ? e.message : String(e) } };
  }
}
