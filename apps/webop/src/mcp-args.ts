import { DEFAULT_BUDGET, type Budget } from "@webop/core/budget";

export const MCP_USAGE =
  "usage: webop mcp [--profile <profile_id|label>] [--image-max-px <n>] [--image-max-tokens <n>] [--px-per-token <n>]\n";

const BUDGET_FLAGS: Record<string, keyof Budget> = {
  "--image-max-px": "maxTargetPx",
  "--image-max-tokens": "maxTargetTokens",
  "--px-per-token": "pxPerToken",
};

/** `webop mcp` flags. Budget flags are positive integers; anything not given keeps the default (1568 / 1568 / 28). */
export function parseMcpArgs(args: string[]): { profile?: string; budget?: Budget } | { error: string } {
  let profile: string | undefined;
  let budget: Budget | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    const value = args[i + 1];
    if (flag === "--profile") {
      if (value === undefined || value === "") return { error: "--profile needs a profile_id or label" };
      profile = value;
      i++;
    } else if (flag in BUDGET_FLAGS) {
      if (value === undefined || !/^[1-9][0-9]*$/.test(value)) return { error: `${flag} needs a positive integer` };
      budget = { ...(budget ?? DEFAULT_BUDGET), [BUDGET_FLAGS[flag]!]: Number(value) };
      i++;
    } else {
      return { error: `unknown option ${flag}` };
    }
  }
  return { profile, budget };
}
