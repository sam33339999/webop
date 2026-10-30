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

async function perform(action: string, tabId: number, args: Record<string, unknown>): Promise<void> {
  switch (action) {
    case "left_click": return click(tabId, ...toViewportPoint(tabId, pointArg(args, "coordinate")));
    case "right_click": return click(tabId, ...toViewportPoint(tabId, pointArg(args, "coordinate")), { button: "right" });
    case "double_click": return click(tabId, ...toViewportPoint(tabId, pointArg(args, "coordinate")), { count: 2 });
    case "hover": return hover(tabId, ...toViewportPoint(tabId, pointArg(args, "coordinate")));
    case "left_click_drag": {
      const from = toViewportPoint(tabId, pointArg(args, "start_coordinate"));
      const to = toViewportPoint(tabId, pointArg(args, "coordinate"));
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
      const [x, y] = toViewportPoint(tabId, pointArg(args, "coordinate"));
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
