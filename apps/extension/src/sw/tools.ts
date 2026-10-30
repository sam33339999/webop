import type { ContentBlock, ToolCall, ToolResult } from "@webop/core/protocol";
import { CdpError } from "./cdp.ts";
import { toViewport } from "@webop/core/coords";
import { getContext, screenshot } from "./capture.ts";
import { click, drag, hover, pressKeys, scroll, typeText } from "./input.ts";

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

async function perform(action: string, tabId: number, args: Record<string, unknown>): Promise<void> {
  const target = () => targetArg(tabId, args, "coordinate", "ref");
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
      const from = await targetArg(tabId, args, "start_coordinate", "start_ref");
      const to = await target();
      return drag(tabId, from, to);
    }
    case "type": return typeText(tabId, textArg(args));
    case "key": {
      try {
        return await pressKeys(tabId, textArg(args));
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

async function run(call: ToolCall): Promise<Outcome> {
  if (call.tool === "computer") {
    const action = String(call.args.action);
    const tabId = tabIdOf(call.args);
    if (action === "screenshot") {
      const { block } = await screenshot(tabId);
      return { content: [block] };
    }
    await perform(action, tabId, call.args);
    const { block } = await screenshot(tabId);
    return { content: [block] };
  }
  if (call.tool === "read_page") {
    const tabId = tabIdOf(call.args);
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
    return { content: [{ type: "text", text: r.text }] };
  }
  invalid(`Unknown tool: ${String(call.tool)}`);
}

export async function dispatch(call: ToolCall): Promise<ToolResult> {
  const base = { id: call.id, session_id: call.session_id };
  try {
    return { ...base, ...(await run(call)) };
  } catch (e) {
    if (e instanceof CdpError) return { ...base, error: { code: e.code, message: e.message } };
    return { ...base, error: { code: "internal", message: e instanceof Error ? e.message : String(e) } };
  }
}
