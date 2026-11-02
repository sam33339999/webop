export type Level = "read" | "act" | "javascript";
export type Scope = "once" | "always";

export interface Policy {
  always: Record<string, Level[]>;
  once: Record<string, Level[]>;
  deny: string[];
  jsEnabled: boolean;
}

/** Required level for a tool call; null = no per-site grant needed (tabs_list, tabs_close). Throws on unknown tools (fail-closed). */
export function levelFor(tool: string, action?: string): Level | null {
  switch (tool) {
    case "javascript":
      return "javascript";
    case "navigate":
    case "tabs_create":
    case "read_page":
    case "get_page_text":
    case "read_console_messages":
    case "read_network_requests":
      return "read";
    case "computer":
      return action === "screenshot" || action === "zoom" ? "read" : "act";
    case "form_input":
      return "act";
    case "tabs_list":
    case "tabs_close":
    case "gif_creator":
      return null;
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

/** `act` implies `read`; `javascript` is only satisfied by itself. */
export function covers(granted: Level[], need: Level): boolean {
  if (need === "javascript") return granted.includes("javascript");
  if (need === "read") return granted.includes("read") || granted.includes("act");
  return granted.includes("act");
}

export function decide(p: Policy, site: string | null, need: Level): "allow" | "deny" | "ask" {
  if (site === null) return "deny";
  if (p.deny.includes(site)) return "deny";
  if (need === "javascript" && !p.jsEnabled) return "deny";
  if (covers(own(p.always, site), need) || covers(own(p.once, site), need)) return "allow";
  return "ask";
}

function own(m: Record<string, Level[]>, site: string): Level[] {
  return Object.hasOwn(m, site) ? m[site]! : [];
}
