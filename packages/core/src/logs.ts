import { redactUrl, redactUrlsInText } from "./redact.ts";

export const LOG_CAP = 1000;
export const TEXT_CAP = 16384;
const TRUNCATED = "…[truncated]";

export type ConsoleEntry = { type: string; text: string; url?: string; line?: number; column?: number; stack?: string; ts: number };
export type NetworkEntry = { requestId: string; url: string; method: string; resourceType: string; status?: number; failed?: string; ts: number };

export class RingLog<T> {
  private items: T[] = [];
  private droppedCount = 0;
  private cap: number;
  constructor(cap: number = LOG_CAP) { this.cap = cap; }
  push(e: T): void {
    this.items.push(e);
    while (this.items.length > this.cap) {
      this.items.shift();
      this.droppedCount++;
    }
  }
  all(): T[] { return this.items.slice(); }
  clear(): void { this.items = []; this.droppedCount = 0; }
  get dropped(): number { return this.droppedCount; }
  find(pred: (e: T) => boolean): T | undefined { return this.items.find(pred); }
}

// Redact first, then truncate, so truncation can never leave part of a credential visible.
function clip(s: string): string {
  const r = redactUrlsInText(s);
  return r.length > TEXT_CAP ? r.slice(0, TEXT_CAP) + TRUNCATED : r;
}

export function makeConsoleEntry(raw: ConsoleEntry): ConsoleEntry {
  const e: ConsoleEntry = { type: raw.type, text: clip(raw.text), ts: raw.ts };
  if (raw.url !== undefined) e.url = redactUrl(raw.url);
  if (raw.line !== undefined) e.line = raw.line;
  if (raw.column !== undefined) e.column = raw.column;
  if (raw.stack !== undefined) e.stack = clip(raw.stack);
  return e;
}

export function makeNetworkEntry(raw: { requestId: string; url: string; method: string; resourceType: string; ts: number }): NetworkEntry {
  return { requestId: raw.requestId, url: redactUrl(raw.url), method: raw.method, resourceType: raw.resourceType, ts: raw.ts };
}

export type ConsoleQuery = { pattern?: RegExp; onlyErrors?: boolean; limit?: number };
export type NetworkQuery = { urlPattern?: string; resourceType?: string; onlyFailed?: boolean; limit?: number };

const DEFAULT_LIMIT = 100;

function lastN<T>(arr: T[], limit?: number): T[] {
  const n = limit ?? DEFAULT_LIMIT;
  return n >= arr.length ? arr : arr.slice(arr.length - n);
}

export function queryConsole(log: RingLog<ConsoleEntry>, q: ConsoleQuery): { matched: number; entries: ConsoleEntry[] } {
  const m = log.all().filter((e) => {
    if (q.onlyErrors && e.type !== "error" && e.type !== "exception") return false;
    if (q.pattern) {
      q.pattern.lastIndex = 0;
      if (!q.pattern.test(e.text)) return false;
    }
    return true;
  });
  return { matched: m.length, entries: lastN(m, q.limit) };
}

export function queryNetwork(log: RingLog<NetworkEntry>, q: NetworkQuery): { matched: number; entries: NetworkEntry[] } {
  const needle = q.urlPattern?.toLowerCase();
  const rt = q.resourceType?.toLowerCase();
  const m = log.all().filter((e) => {
    if (needle !== undefined && !e.url.toLowerCase().includes(needle)) return false;
    if (rt !== undefined && e.resourceType.toLowerCase() !== rt) return false;
    if (q.onlyFailed && !(e.failed !== undefined || (e.status !== undefined && e.status >= 400))) return false;
    return true;
  });
  return { matched: m.length, entries: lastN(m, q.limit) };
}

function summary(r: { matched: number; entries: unknown[]; dropped: number }): string {
  let s = `${r.matched} matching, ${r.entries.length} shown`;
  if (r.dropped > 0) s += ` (${r.dropped} older entries were dropped)`;
  return s;
}

export function formatConsole(r: { matched: number; entries: ConsoleEntry[]; dropped: number; notes: string[] }): string {
  const lines = [summary(r), ...r.notes];
  for (const e of r.entries) {
    let line = `[${e.type}] ${e.text}`;
    if (e.url) line += ` (${e.url}${e.line !== undefined ? `:${e.line}` : ""}${e.column !== undefined ? `:${e.column}` : ""})`;
    lines.push(line);
    if (e.type === "exception" && e.stack) {
      for (const s of e.stack.split("\n")) lines.push(`    ${s}`);
    }
  }
  return lines.join("\n");
}

export function formatNetwork(r: { matched: number; entries: NetworkEntry[]; dropped: number; notes: string[] }): string {
  const lines = [summary(r), ...r.notes];
  for (const e of r.entries) {
    const state = e.failed !== undefined ? `failed ${e.failed}` : e.status !== undefined ? String(e.status) : "pending";
    lines.push(`${e.method} ${state} ${e.resourceType} ${e.url}`);
  }
  return lines.join("\n");
}

export function parsePattern(src: string): RegExp {
  try {
    return new RegExp(src, "i");
  } catch {
    throw new Error(`Invalid regular expression: ${src}`);
  }
}
