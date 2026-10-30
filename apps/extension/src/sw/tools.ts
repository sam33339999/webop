import type { ContentBlock, ToolCall, ToolResult } from "@webop/core/protocol";
import { CdpError } from "./cdp.ts";
import { screenshot } from "./capture.ts";

type Outcome = { content: ContentBlock[] };

function invalid(message: string): never {
  throw new CdpError("invalid_args", message);
}

function tabIdOf(args: Record<string, unknown>): number {
  const id = args.tab_id;
  if (typeof id !== "number" || !Number.isInteger(id)) invalid("tab_id must be an integer.");
  return id;
}

async function run(call: ToolCall): Promise<Outcome> {
  if (call.tool === "computer") {
    if (call.args.action === "screenshot") {
      const { block } = await screenshot(tabIdOf(call.args));
      return { content: [block] };
    }
    invalid(`Unknown computer action: ${String(call.args.action)}`);
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
