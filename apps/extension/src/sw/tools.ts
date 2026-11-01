import { sendWithInject } from "./inject.ts";
import type { ContentBlock, ToolCall, ToolResult } from "@webop/core/protocol";
import { CdpError, dialogError, dropDetachNoticeSince, inputsSentTo, isDialogOpen, notePageChange, resumeTab, send, stoppedError, takeDetachNotice, timeouts } from "./cdp.ts";
import { toViewport } from "@webop/core/coords";
import { getContext, screenshot, withStopButtonHidden, zoom } from "./capture.ts";
import { click, drag, hover, pressKeys, scroll, typeText } from "./input.ts";
import { assertLive, assertOwned, budgetOf, clientNameOf, createTab, ensureSession, isOwned, listTabs, showGlow } from "./sessions.ts";
import { siteOf } from "@webop/core/domain";
import { accessState, askInBackground, deniedError, isSiteReadable, requireAccess } from "./permissions.ts";
import { openCallContext, PENDING_MARGIN_MS, type CallContext } from "./callctx.ts";
import { promptTimeouts } from "./prompt.ts";
import { levelFor, type Level } from "@webop/core/grants";

type Outcome = { content: ContentBlock[] };

/** Dev-only seams for e2e tests (see the `__webop` hook); never set in a production build. */
export const devHooks: { afterTarget?: (tabId: number) => Promise<void> } = {};

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

async function viewportSize(tabId: number): Promise<{ width: number; height: number }> {
  const r = await send<{ result: { value: { width: number; height: number } } }>(tabId, "Runtime.evaluate", {
    expression: "({ width: innerWidth, height: innerHeight })",
    returnByValue: true,
  });
  return r.result.value;
}

/** Screenshot-frame coordinate -> viewport CSS px, using the context of the last screenshot of this tab. */
async function toViewportPoint(tabId: number, point: [number, number]): Promise<[number, number]> {
  const ctx = getContext(tabId);
  if (!ctx) invalid("No screenshot context for this tab; take a screenshot first.");
  const now = await viewportSize(tabId);
  if (now.width !== ctx.viewportWidth || now.height !== ctx.viewportHeight) {
    invalid(`Not performed: the viewport changed size since the last screenshot (${ctx.viewportWidth}x${ctx.viewportHeight} → ${now.width}x${now.height}); take a new screenshot and use its coordinates.`);
  }
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
    return await Promise.race([sendWithInject<T>(tabId, msg, isOwned), timeout]);
  } catch (e) {
    if (!(await chrome.tabs.get(tabId).then(() => true, () => false))) throw new CdpError("tab_not_in_session", `Tab ${tabId} was closed.`);
    if (e instanceof CdpError) throw e;
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

/** The site re-read an input action passes right before input is sent (permission was settled before the page was touched). */
interface InputGuard {
  beforeInput(): Promise<void>;
}

/** computer actions that only look at the page (read level, no input). */
const READ_ACTIONS: ReadonlySet<string> = new Set(["screenshot", "zoom"]);

function regionArg(args: Record<string, unknown>): [number, number, number, number] {
  const v = args.region;
  if (!Array.isArray(v) || v.length !== 4 || !v.every((n) => typeof n === "number" && Number.isFinite(n))) {
    invalid("region must be [x0, y0, x1, y1] in screenshot coordinates.");
  }
  return [v[0], v[1], v[2], v[3]];
}

const INPUT_ACTIONS: ReadonlySet<string> = new Set([
  "left_click", "right_click", "double_click", "hover", "scroll_to", "left_click_drag", "type", "key", "scroll",
]);

/**
 * Where the user is shown the click will land, computed from the stored screenshot context alone (no page call).
 * Ref targets get no marker: their position is only known by asking the page. Anything unusable just means no marker.
 */
function markerFor(action: string, tabId: number, args: Record<string, unknown>): Point | undefined {
  const name = action === "left_click_drag" ? "start_coordinate" : "coordinate";
  const ctx = getContext(tabId);
  const v = args[name];
  if (!ctx || args.ref !== undefined || args.start_ref !== undefined) return undefined;
  if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== "number" || typeof v[1] !== "number") return undefined;
  const r = toViewport(v[0], v[1], ctx);
  return "oobError" in r ? undefined : { x: r.viewport[0], y: r.viewport[1] };
}

async function perform(action: string, tabId: number, args: Record<string, unknown>, g: InputGuard): Promise<void> {
  const target = () => guardedTarget(tabId, args, "coordinate", "ref");
  /** Resolves the single target, then re-checks the site. */
  const aim = async (): Promise<[number, number]> => {
    const p = await target();
    await g.beforeInput();
    return p;
  };
  switch (action) {
    case "left_click": return click(tabId, ...(await aim()));
    case "right_click": return click(tabId, ...(await aim()), { button: "right" });
    case "double_click": return click(tabId, ...(await aim()), { count: 2 });
    case "hover": return hover(tabId, ...(await aim()));
    case "scroll_to": {
      if (args.ref === undefined) invalid("scroll_to requires ref.");
      // scrollIntoView changes the page without any Input.*; count it as an action that began.
      notePageChange(tabId);
      await refPoint(tabId, args.ref);
      await g.beforeInput();
      return;
    }
    case "left_click_drag": {
      const from = await guardedTarget(tabId, args, "start_coordinate", "start_ref");
      const to = await target();
      await g.beforeInput();
      return drag(tabId, from, to);
    }
    case "type": {
      const text = textArg(args);
      await assertNotCrossSiteFrame(tabId);
      await g.beforeInput();
      return typeText(tabId, text);
    }
    case "key": {
      const combo = textArg(args);
      await assertNotCrossSiteFrame(tabId);
      await g.beforeInput();
      try {
        return await pressKeys(tabId, combo);
      } catch (e) {
        if (e instanceof CdpError) throw e;
        invalid(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    case "scroll": {
      const [x, y] = await aim();
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
function assertBeforeDeadline(ctx: CallContext): void {
  if (ctx.stopped()) throw stoppedError();
  if (ctx.signal.aborted) {
    throw new CdpError("timeout", "Not performed: the caller cancelled this call.");
  }
  if (Date.now() > ctx.deadline) {
    throw new CdpError("timeout", "Not performed: the tab was busy with an earlier call past this call's deadline.");
  }
}

/** After a stop, whatever went wrong in the call is the stop (a detach or a declined prompt is how it showed up). */
function viaStop(e: unknown, ctx: CallContext): unknown {
  if (!ctx.stopped()) return e;
  if (e instanceof CdpError && (e.code === "stopped_by_user" || e.code === "detached_by_user")) return e;
  return stoppedError();
}

/** A blocked page (dialog, long script) must fail fast with "Not performed" instead of queueing input that lands later. */
async function assertResponsive(tabId: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dead = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("probe timeout")), timeouts.probeMs); });
  try {
    await Promise.race([send(tabId, "Runtime.evaluate", { expression: "1", returnByValue: true }), dead]);
  } catch (e) {
    if (e instanceof CdpError && e.code !== "timeout") throw e;
    if (isDialogOpen(tabId)) throw dialogError();
    throw new CdpError("timeout", "Not performed: the page is not responding (a JavaScript dialog or long-running script may be blocking it).");
  } finally {
    clearTimeout(timer);
  }
}

const NAVIGATE_TIMEOUT_MS = 30000;

/** Resolves once the tab has finished loading what `start` kicked off; rejects with `timeout` after 30 s. */
export async function afterLoad(tabId: number, start: () => Promise<unknown>, limitMs = NAVIGATE_TIMEOUT_MS): Promise<void> {
  if (limitMs <= 0) throw new CdpError("timeout", "Not performed: the call's time budget was already spent before the navigation could start.");
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
    timer = setTimeout(() => reject(new CdpError("timeout", `Page did not finish loading within ${Math.max(0, Math.round(limitMs / 100) / 10)}s.`)), limitMs);
  });
  // If start() throws, `timeout` is never awaited; keep its later rejection from becoming unhandled.
  timeout.catch(() => {});
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

/** The tab's committed URL and, while a navigation is in flight, the URL it is heading to. */
async function tabUrls(tabId: number): Promise<{ url: string; pendingUrl?: string }> {
  try {
    const t = await chrome.tabs.get(tabId);
    return { url: t.url ?? "", pendingUrl: t.pendingUrl };
  } catch {
    throw new CdpError("tab_not_in_session", `Tab ${tabId} does not exist.`);
  }
}

/**
 * Blocks until the session holds `level` on the URL's site (asking the user when needed); the call's deadline restarts
 * after an answer, and a cancel or an expired deadline stops the call before anything state-changing starts.
 */
async function gate(session_id: string, ctx: CallContext, url: string, level: Level, o: { tabId?: number; marker?: Point; what?: string } = {}): Promise<void> {
  let asked = false;
  await requireAccess({
    session_id, client_name: await clientNameOf(session_id), url, level, ...o, signal: ctx.signal,
    beforeAsk() {
      asked = true;
      ctx.notifyPending(promptTimeouts.askMs + PENDING_MARGIN_MS);
    },
  });
  if (asked) ctx.resetDeadline();
  assertBeforeDeadline(ctx);
}

function urlArg(args: Record<string, unknown>): string {
  if (typeof args.url !== "string" || args.url === "") invalid("url must be a non-empty string.");
  return args.url;
}

/** Resolves the history entry through CDP so its site can be checked BEFORE loading it. */
async function historyEntry(tabId: number, dir: "back" | "forward"): Promise<{ id: number; url: string }> {
  const h = await send<{ currentIndex: number; entries: { id: number; url: string }[] }>(tabId, "Page.getNavigationHistory");
  const entry = h.entries[h.currentIndex + (dir === "back" ? -1 : 1)];
  if (!entry) throw new CdpError("invalid_args", `Cannot go ${dir}: no such history entry.`);
  return entry;
}

/**
 * Re-checks the tab's current site after content was produced; content is withheld unless the session may `read` it.
 * A site that only needs the user's approval answers permission_required and shows the question, so a retry can succeed.
 * Returns the URL that was checked, so callers report exactly that value and never read the tab again.
 */
async function recheck(session_id: string, tabId: number, performed: boolean, ctx: CallContext): Promise<string> {
  const url = await currentUrl(tabId);
  const state = await accessState(session_id, url, "read");
  if (state === "allow") return url;
  const site = siteOf(url) ?? "non-web page";
  const lead = performed ? "The action WAS performed, but the" : "The";
  if (state === "deny") {
    throw new CdpError("permission_denied", `${lead} tab is now on a site that is not allowed (${site}); no content is returned.`);
  }
  const client_name = await clientNameOf(session_id);
  if (ctx.stopped()) throw stoppedError();
  askInBackground({ session_id, client_name, url, level: "read", tabId });
  throw new CdpError("permission_required", `${lead} tab is now on ${site}, which needs the user's approval; no content is returned. A prompt was shown to the user; after they allow it, retry (e.g. read_page).`);
}

/** Input may only go to the site the user authorized: a tab that moved (or is moving) elsewhere is not touched. */
async function assertStillOn(tabId: number, authorizedUrl: string): Promise<void> {
  const { url, pendingUrl } = await tabUrls(tabId);
  const was = siteOf(authorizedUrl);
  for (const u of [url, pendingUrl]) {
    if (u !== undefined && siteOf(u) !== was) {
      throw new CdpError("security_check_failed", `Not performed: the tab moved from ${was ?? authorizedUrl} to ${siteOf(u) ?? u} before input was sent.`);
    }
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

/**
 * Reads never block on a prompt (spec 4.4): a tab that is on a site this session may not read gets permission_required
 * and the question is shown in the background, so a retry can succeed once the user allows it.
 */
async function requireReadable(session_id: string, tabId: number, ctx: CallContext, notPerformed = false): Promise<void> {
  const url = await currentUrl(tabId);
  const state = await accessState(session_id, url, "read");
  if (state === "deny") throw deniedError(url);
  if (state === "ask") {
    const site = siteOf(url);
    const client_name = await clientNameOf(session_id);
    if (ctx.stopped()) throw stoppedError();
    askInBackground({ session_id, client_name, url, level: "read", tabId });
    throw new CdpError("permission_required", `${notPerformed ? "Not performed: t" : "T"}he tab is on ${site}, which this agent has not been allowed to read; the user has been asked. Retry after they allow it.`);
  }
  assertBeforeDeadline(ctx);
}

/**
 * After a navigation or tab creation went out, a stop or cancel no longer means "Not performed": the change happened
 * (or may still complete), so the error says that instead.
 */
function afterStart(e: unknown, ctx: CallContext, lead: string): unknown {
  if (!(e instanceof CdpError) || e.code === "detached_by_user") return e;
  if (e.code === "stopped_by_user" || ctx.stopped()) return new CdpError("stopped_by_user", `${lead}: the user pressed stop.`);
  if (e.code === "timeout" && e.message.startsWith("Not performed: the caller cancelled")) {
    return new CdpError("timeout", `${lead}: the caller cancelled this call.`);
  }
  return e;
}

async function navigate(session_id: string, args: Record<string, unknown>, ctx: CallContext): Promise<Outcome> {
  const tabId = tabIdOf(args);
  const target = urlArg(args);
  await assertOwned(session_id, tabId);
  const history = target === "back" || target === "forward";
  // Reading the history entry means debugging the tab; a tab whose current site is not readable is not touched at all.
  if (history) await requireReadable(session_id, tabId, ctx, true);
  const entry = history ? await historyEntry(tabId, target) : undefined;
  await gate(session_id, ctx, entry ? entry.url : target, "read", { tabId, what: "the navigation was not started" });
  void showGlow(session_id, tabId, ctx.stopped);
  // The wait is capped by the call's deadline so the extension answers before the MCP host gives up.
  const limit = Math.min(NAVIGATE_TIMEOUT_MS, Math.max(0, ctx.deadline - Date.now()));
  const lead = "The navigation was started and may still complete";
  let started = false;
  let final: string;
  try {
    await afterLoad(tabId, async () => {
      if (entry) {
        await send(tabId, "Page.navigateToHistoryEntry", { entryId: entry.id });
      } else {
        await chrome.tabs.update(tabId, { url: target });
      }
      started = true;
    }, limit);
    final = await recheck(session_id, tabId, true, ctx);
  } catch (e) {
    if (!started) throw e;
    if (e instanceof CdpError && e.code === "timeout" && e.message.startsWith("Page did not finish")) {
      throw afterStart(new CdpError("timeout", `${lead}. ${e.message}`), ctx, lead);
    }
    throw afterStart(e, ctx, lead);
  }
  return { content: [{ type: "text", text: `Navigated to ${final}` }] };
}

/** Errors that mean more than "the capture failed": they must never be reported as a successful action. */
const NOT_A_CAPTURE_FAILURE: ReadonlySet<string> = new Set([
  "detached_by_user", "stopped_by_user", "tab_not_in_session", "permission_denied", "permission_required", "security_check_failed",
]);

const tabQueues = new Map<number, Promise<void>>();

/** Runs `fn` after every earlier call on the same tab has finished (FIFO), so overlay hiding, captures and input sequences never interleave. */
async function withTab<T>(tabId: number, ctx: CallContext, fn: () => Promise<T>): Promise<T> {
  const prev = tabQueues.get(tabId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const tail = prev.then(() => mine);
  tabQueues.set(tabId, tail);
  await prev;
  try {
    assertBeforeDeadline(ctx);
    // This call started after the last stop, so the tab may be attached to again.
    resumeTab(tabId);
    if (takeDetachNotice(tabId)) {
      throw new CdpError("detached_by_user", "Not performed: the user stopped debugging this tab; retry to re-attach.");
    }
    const startedAt = Date.now();
    try {
      const result = await fn();
      if (ctx.stopped()) dropDetachNoticeSince(tabId, startedAt);
      return result;
    } catch (e) {
      // This call is the one that tells the caller about a cancel that happened while it ran; the next call need not.
      if (ctx.stopped() || (e instanceof CdpError && (e.code === "stopped_by_user" || e.code === "detached_by_user"))) dropDetachNoticeSince(tabId, startedAt);
      throw e;
    }
  } finally {
    release();
    if (tabQueues.get(tabId) === tail) tabQueues.delete(tabId);
  }
}

// `ctx` carries the abort signal and the (resettable) deadline; the permission gate also uses notifyPending.
async function run(call: ToolCall, ctx: CallContext): Promise<Outcome> {
  await ensureSession(call.session_id);
  if (call.tool === "tabs_list") {
    // A tab can wander off the allowlist (redirect, user); never leak its title or URL.
    const tabs = await Promise.all((await listTabs(call.session_id)).map(async (t) =>
      (await isSiteReadable(call.session_id, t.url)) ? t : { tab_id: t.tab_id, title: "", url: "(site not allowed)" }));
    return { content: [{ type: "text", text: JSON.stringify(tabs) }] };
  }
  if (call.tool === "tabs_create") {
    const url = urlArg(call.args);
    await gate(call.session_id, ctx, url, "read", { what: "no tab was opened" });
    const tab = await createTab(call.session_id, url, () => assertBeforeDeadline(ctx));
    const tab_id = tab.id as number;
    void showGlow(call.session_id, tab_id, ctx.stopped);
    let closed = false;
    try {
      await afterLoad(tab_id, async () => {});
      let landed: string;
      try {
        landed = await currentUrl(tab_id);
        const state = await accessState(call.session_id, landed, "read");
        if (state === "deny") throw deniedError(landed, "The tab was closed");
        if (state === "ask") {
          const client_name = await clientNameOf(call.session_id);
          if (ctx.stopped()) throw stoppedError();
          askInBackground({ session_id: call.session_id, client_name, url: landed, level: "read" });
          throw new CdpError("permission_required", `The tab was closed because it ended up on ${siteOf(landed)}, which needs the user's approval. A prompt was shown to the user; after they allow it, retry tabs_create.`);
        }
        assertBeforeDeadline(ctx);
      } catch (e) {
        await chrome.tabs.remove(tab_id).catch(() => {});
        closed = true;
        throw e;
      }
      // The URL that was just checked, not a fresh read.
      return { content: [{ type: "text", text: JSON.stringify({ tab_id, url: landed }) }] };
    } catch (e) {
      throw afterStart(e, ctx, closed ? "The tab was opened and has been closed" : "The tab was opened and is still open");
    }
  }
  if (call.tool === "tabs_close") {
    const tabId = tabIdOf(call.args);
    // Deliberately outside withTab: closing must work while the page is blocked; queued calls then fail on their own (tab gone).
    await assertOwned(call.session_id, tabId);
    assertBeforeDeadline(ctx);
    await chrome.tabs.remove(tabId);
    return { content: [{ type: "text", text: `Closed tab ${tabId}` }] };
  }
  if (call.tool === "navigate") {
    const tabId = tabIdOf(call.args);
    return withTab(tabId, ctx, () => navigate(call.session_id, call.args, ctx));
  }
  if (call.tool === "computer") {
    const action = String(call.args.action);
    const tabId = tabIdOf(call.args);
    return withTab(tabId, ctx, async () => {
      await assertOwned(call.session_id, tabId);
      const performed = !READ_ACTIONS.has(action);
      const first = await currentUrl(tabId);
      if (!performed) {
        await requireReadable(call.session_id, tabId, ctx);
      } else {
        if (!INPUT_ACTIONS.has(action)) invalid(`Unknown computer action: ${action}`);
        // Permission comes BEFORE anything touches the page (target lookup, scrolling, frame check, probe): a refused
        // or declined site must see no webop activity at all. A deny answers here without any page call.
        await gate(call.session_id, ctx, first, "act", { tabId, marker: markerFor(action, tabId, call.args), what: "no input was sent" });
      }
      void showGlow(call.session_id, tabId, ctx.stopped);
      const assertSameSite = () => assertStillOn(tabId, first);
      const guard: InputGuard = {
        async beforeInput() {
          if (__DEV__) await devHooks.afterTarget?.(tabId);
          await assertSameSite();
          assertBeforeDeadline(ctx);
        },
      };
      if (performed) {
        // The user may have taken a while (or the tab moved on); nothing computed before the answer is reused, and a
        // tab that left the authorized site is not touched at all.
        await assertSameSite();
        await assertResponsive(tabId);
        // The probe can take up to probeMs; a cancel or session end during it must stop us before any input.
        assertBeforeDeadline(ctx);
      }
      const budget = await budgetOf(call.session_id);
      if (action === "zoom") {
        const region = regionArg(call.args);
        const z = await zoom(tabId, region, budget);
        await assertLive(call.session_id);
        await recheck(call.session_id, tabId, false, ctx);
        if (ctx.stopped()) throw stoppedError();
        return { content: [{ type: "text", text: `Zoom of [${region.join(",")}] at ${z.width}x${z.height} px; coordinates still use the last screenshot frame.` }, z.block] };
      }
      const inputsBefore = inputsSentTo(tabId);
      try {
        if (performed) {
          await withStopButtonHidden(tabId, () => perform(action, tabId, call.args, guard));
          await settle(tabId);
        }
        // The input opened a dialog: the page's script thread is frozen until the user dismisses it. The action did land.
        const blocked = performed && isDialogOpen(tabId);
        const dialogNote = " The action WAS performed; a JavaScript dialog is now open and blocks the page, so nothing else will run until it is dismissed.";
        await assertLive(call.session_id);
        await recheck(call.session_id, tabId, performed, ctx);
        if (ctx.stopped()) throw stoppedError();
        let shot: Awaited<ReturnType<typeof screenshot>>;
        try {
          shot = await screenshot(tabId, { budget });
        } catch (e) {
          // The action already went out in full; a failed capture must not read as a failed action.
          if (!performed || (e instanceof CdpError && NOT_A_CAPTURE_FAILURE.has(e.code))) throw e;
          await assertLive(call.session_id);
          await recheck(call.session_id, tabId, performed, ctx);
          const why = e instanceof Error ? e.message : String(e);
          return { content: [{ type: "text", text: `Action performed; screenshot failed: ${why}${blocked ? dialogNote : ""}` }] };
        }
        await recheck(call.session_id, tabId, performed, ctx);
        // The user may have pressed stop while we were busy; the result is withheld.
        if (ctx.stopped()) throw stoppedError();
        const { block, ctx: shotCtx } = shot;
        return { content: [{ type: "text", text: `Screenshot ${shotCtx.screenshotWidth}x${shotCtx.screenshotHeight} px; use this frame for coordinates.${blocked ? dialogNote : ""}` }, block] };
      } catch (caught) {
        const e = viaStop(caught, ctx);
        // Once input has gone out, a failure no longer means "nothing happened".
        if (inputsSentTo(tabId) === inputsBefore) {
          // Nothing went out: say so, whatever stopped the action before its first input.
          if (e instanceof CdpError && !e.message.startsWith("Not performed") && !e.message.includes("WAS performed")) throw new CdpError(e.code, `Not performed: ${e.message}`);
          throw e;
        }
        const prefix = "The action may have been partially or fully performed: ";
        const code = e instanceof CdpError ? e.code : "internal";
        const message = e instanceof CdpError && e.code === "stopped_by_user" ? "the user pressed stop." : e instanceof Error ? e.message : String(e);
        if (message.includes("WAS performed")) throw e;
        throw new CdpError(code, prefix + message);
      }
    });
  }
  if (call.tool === "read_page") {
    const tabId = tabIdOf(call.args);
    return withTab(tabId, ctx, () => readPage(call, ctx));
  }
  if (call.tool === "form_input") {
    const tabId = tabIdOf(call.args);
    return withTab(tabId, ctx, () => formInput(call, ctx));
  }
  if (call.tool === "javascript") {
    const tabId = tabIdOf(call.args);
    return withTab(tabId, ctx, () => runJavascript(call, ctx));
  }
  if (call.tool === "get_page_text") {
    const tabId = tabIdOf(call.args);
    return withTab(tabId, ctx, () => pageText(call, ctx));
  }
  invalid(`Unknown tool: ${String(call.tool)}`);
}

async function readPage(call: ToolCall, ctx: CallContext): Promise<Outcome> {
  const tabId = tabIdOf(call.args);
  await assertOwned(call.session_id, tabId);
  await requireReadable(call.session_id, tabId, ctx);
  void showGlow(call.session_id, tabId, ctx.stopped);
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
  await recheck(call.session_id, tabId, false, ctx);
  return { content: [{ type: "text", text: r.text }] };
}

type FormInputReply = { ok: true; kind: string } | { error: "stale_ref" | "unsupported" | "bad_value"; message: string };

/**
 * Sets one form field by ref (act level). The value is never echoed back: it may be a password. The same checks as
 * computer input apply: permission before the page is touched, the tab still on the authorized site, the page alive.
 */
async function formInput(call: ToolCall, ctx: CallContext): Promise<Outcome> {
  const tabId = tabIdOf(call.args);
  const { ref, value } = call.args;
  if (typeof ref !== "string" || ref === "") invalid("ref must be a non-empty string.");
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") invalid("value must be a string, number or boolean.");
  await assertOwned(call.session_id, tabId);
  const authorizedUrl = await currentUrl(tabId);
  await gate(call.session_id, ctx, authorizedUrl, "act", { tabId, what: "no field was changed" });
  void showGlow(call.session_id, tabId, ctx.stopped);
  await assertStillOn(tabId, authorizedUrl);
  await assertResponsive(tabId);
  assertBeforeDeadline(ctx);
  if (__DEV__) await devHooks.afterTarget?.(tabId);
  await assertStillOn(tabId, authorizedUrl);
  assertBeforeDeadline(ctx);
  notePageChange(tabId);
  let kind: string;
  try {
    const r = await askContent<FormInputReply | undefined>(tabId, { type: "webop:form_input", ref, value });
    if (!r) throw new CdpError("internal", "Page content script returned no reply.");
    if ("error" in r) {
      // The page refused before changing anything.
      if (r.error === "stale_ref") throw new CdpError("stale_ref", `Not performed: ${ref} ${r.message}; call read_page again to get fresh refs.`);
      throw new CdpError("invalid_args", `Not performed: ${ref}: ${r.message}.`);
    }
    kind = r.kind;
  } catch (caught) {
    const e = viaStop(caught, ctx);
    if (e instanceof CdpError && (e.message.startsWith("Not performed") || e.code === "tab_not_in_session")) throw e;
    const message = e instanceof CdpError && e.code === "stopped_by_user" ? "the user pressed stop." : e instanceof Error ? e.message : String(e);
    throw new CdpError(e instanceof CdpError ? e.code : "internal", `The field may have been changed: ${message}`);
  }
  await settle(tabId);
  await assertLive(call.session_id);
  await recheck(call.session_id, tabId, true, ctx);
  if (ctx.stopped()) throw new CdpError("stopped_by_user", "The field WAS set: the user pressed stop.");
  const done = `Set ${kind} ${ref}.`;
  let shot: Awaited<ReturnType<typeof screenshot>>;
  try {
    shot = await screenshot(tabId, { budget: await budgetOf(call.session_id) });
  } catch (e) {
    if (e instanceof CdpError && NOT_A_CAPTURE_FAILURE.has(e.code)) throw e;
    return { content: [{ type: "text", text: `${done} Screenshot failed: ${e instanceof Error ? e.message : String(e)}` }] };
  }
  await recheck(call.session_id, tabId, true, ctx);
  if (ctx.stopped()) throw new CdpError("stopped_by_user", "The field WAS set: the user pressed stop.");
  const { block, ctx: shotCtx } = shot;
  return { content: [{ type: "text", text: `${done} Screenshot ${shotCtx.screenshotWidth}x${shotCtx.screenshotHeight} px; use this frame for coordinates.` }, block] };
}

const JS_TIMEOUT_MS = 10_000;
const JS_MAX_CHARS = 50_000;

type EvalReply = {
  result: { type: string; value?: unknown; description?: string };
  exceptionDetails?: { text: string; exception?: { description?: string } };
};

/** What the agent sees of an evaluation: the JSON value, `undefined`, or a description for values JSON cannot carry. */
function describeResult(r: EvalReply): string {
  if (r.exceptionDetails) return `Error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`;
  const { type, value, description } = r.result;
  if (type === "undefined") return "undefined";
  if (value === undefined) return description ?? type;
  return JSON.stringify(value) ?? String(value);
}

/**
 * Runs agent-supplied code in the page (javascript level: off unless the user switched it on in options, and then asked
 * per site). Exceptions in the code are a normal result, not a tool error. The result is withheld if the tab left a
 * site this session may read.
 */
async function runJavascript(call: ToolCall, ctx: CallContext): Promise<Outcome> {
  const tabId = tabIdOf(call.args);
  const code = call.args.code;
  if (typeof code !== "string" || code.trim() === "") invalid("code must be a non-empty string.");
  await assertOwned(call.session_id, tabId);
  const authorizedUrl = await currentUrl(tabId);
  await gate(call.session_id, ctx, authorizedUrl, "javascript", { tabId, what: "no code was run" });
  void showGlow(call.session_id, tabId, ctx.stopped);
  await assertStillOn(tabId, authorizedUrl);
  await assertResponsive(tabId);
  assertBeforeDeadline(ctx);
  notePageChange(tabId);
  let text: string;
  try {
    const r = await send<EvalReply>(tabId, "Runtime.evaluate", {
      expression: code, awaitPromise: true, returnByValue: true, userGesture: false, timeout: JS_TIMEOUT_MS,
    });
    text = describeResult(r);
  } catch (caught) {
    const e = viaStop(caught, ctx);
    if (e instanceof CdpError && (e.message.startsWith("Not performed") || e.code === "tab_not_in_session")) throw e;
    const message = e instanceof CdpError && e.code === "stopped_by_user" ? "the user pressed stop." : e instanceof Error ? e.message : String(e);
    throw new CdpError(e instanceof CdpError ? e.code : "internal", `The code may have run: ${message}`);
  }
  await assertLive(call.session_id);
  await recheck(call.session_id, tabId, true, ctx);
  if (ctx.stopped()) throw new CdpError("stopped_by_user", "The code WAS run: the user pressed stop.");
  if (text.length > JS_MAX_CHARS) text = `${text.slice(0, JS_MAX_CHARS)}…(truncated)`;
  return { content: [{ type: "text", text }] };
}

async function pageText(call: ToolCall, ctx: CallContext): Promise<Outcome> {
  const tabId = tabIdOf(call.args);
  await assertOwned(call.session_id, tabId);
  await requireReadable(call.session_id, tabId, ctx);
  const { max_chars } = call.args;
  if (max_chars !== undefined && (typeof max_chars !== "number" || !Number.isFinite(max_chars) || max_chars <= 0)) invalid("max_chars must be a positive number.");
  void showGlow(call.session_id, tabId, ctx.stopped);
  const r = await askContent<{ text: string; truncated: boolean } | undefined>(tabId, { type: "webop:page_text", max_chars: max_chars ?? 50000 });
  if (!r || typeof r.text !== "string") throw new CdpError("internal", "Page content script returned no reply.");
  await assertLive(call.session_id);
  // The text is handed back only if the tab is still on a site this session may read.
  const url = await recheck(call.session_id, tabId, false, ctx);
  const title = await chrome.tabs.get(tabId).then((t) => t.title ?? "", () => "");
  const body = r.truncated ? `${r.text}\n…(truncated)` : r.text;
  return { content: [{ type: "text", text: `Title: ${title}\nURL: ${url}\n\n${body}` }] };
}

export async function dispatch(call: ToolCall): Promise<ToolResult> {
  const base = { id: call.id, session_id: call.session_id };
  const { ctx, close } = openCallContext(call.session_id, call.id);
  try {
    // Every tool goes through the grant map first; an unknown one fails closed.
    try {
      levelFor(call.tool, typeof call.args?.action === "string" ? call.args.action : undefined);
    } catch {
      invalid(`Unknown tool: ${String(call.tool)}`);
    }
    const outcome = await run(call, ctx);
    // A stop that landed while the call was finishing: the result is not handed back.
    if (ctx.stopped()) {
      // Reads changed nothing; navigations and tab changes did happen even though the result is withheld.
      const readOnly = call.tool === "read_page" || call.tool === "get_page_text" || call.tool === "tabs_list" || (call.tool === "computer" && READ_ACTIONS.has(String(call.args.action)));
      throw readOnly ? stoppedError() : new CdpError("stopped_by_user", "The action may have been partially or fully performed: the user pressed stop.");
    }
    return { ...base, ...outcome };
  } catch (caught) {
    const e = viaStop(caught, ctx);
    if (e instanceof CdpError) return { ...base, error: { code: e.code, message: e.message } };
    return { ...base, error: { code: "internal", message: e instanceof Error ? e.message : String(e) } };
  } finally {
    close();
  }
}
