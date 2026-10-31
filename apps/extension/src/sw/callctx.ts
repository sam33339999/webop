import type { ExtToHost } from "@webop/core/protocol";
import { timeouts } from "./cdp.ts";

/** Slack added on top of the ask timeout so the host's timer outlives the popup's own deadline. */
export const PENDING_MARGIN_MS = 10_000;

/** Per-call state handed to a tool while it runs. */
export interface CallContext {
  /** Aborted when the host relays `tool_cancel` (the agent gave up); pass it to `ask()`. */
  readonly signal: AbortSignal;
  /** Absolute time after which nothing state-changing may start. Starts at call time + `callDeadlineMs`. */
  deadline: number;
  /** Tells the agent side the call is waiting on the user: its timeout restarts at `extendMs` + its own call timeout. */
  notifyPending(extendMs: number): void;
  /** Restarts `deadline` from now; call it right AFTER a grant came back, never before. */
  resetDeadline(): void;
}

type Sink = (msg: ExtToHost) => void;
let sink: Sink = () => {};
/** The native link installs itself here so tools never import it. */
export function setPendingSink(s: Sink): void {
  sink = s;
}

const live = new Map<string, { ac: AbortController; session_id: string }>();
const keyOf = (session_id: string, id: string): string => JSON.stringify([session_id, id]);

export function openCallContext(session_id: string, id: string): { ctx: CallContext; close(): void } {
  const ac = new AbortController();
  const key = keyOf(session_id, id);
  const entry = { ac, session_id };
  live.set(key, entry);
  const ctx: CallContext = {
    signal: ac.signal,
    deadline: Date.now() + timeouts.callDeadlineMs,
    notifyPending(extendMs) {
      if (ac.signal.aborted) return;
      sink({ type: "tool_pending", id, session_id, extend_ms: Math.min(600_000, Math.max(1, Math.ceil(extendMs))) });
    },
    resetDeadline() {
      ctx.deadline = Date.now() + timeouts.callDeadlineMs;
    },
  };
  return { ctx, close: () => { if (live.get(key) === entry) live.delete(key); } };
}

/** Host relayed `tool_cancel`: aborts the matching call. Unknown or finished calls are a no-op. */
export function cancelCall(session_id: string, id: string): void {
  live.get(keyOf(session_id, id))?.ac.abort();
}

/** The session ended: every call it still has in flight is abandoned (pending prompts deny, nothing more runs). */
export function cancelSession(session_id: string): void {
  for (const e of live.values()) if (e.session_id === session_id) e.ac.abort();
}
