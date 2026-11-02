import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RingLog, makeConsoleEntry, makeNetworkEntry, queryConsole, queryNetwork,
  formatConsole, formatNetwork, parsePattern, timeOf, PATTERN_MAX, TEXT_CAP, type ConsoleEntry, type NetworkEntry,
} from "../src/logs.ts";

const c = (type: string, text: string, ts = 0): ConsoleEntry => ({ type, text, ts });
const n = (o: Partial<NetworkEntry>): NetworkEntry => ({ requestId: "1", url: "https://a.com/", method: "GET", resourceType: "fetch", ts: 0, ...o });

test("RingLog drops oldest and counts", () => {
  const l = new RingLog<number>(3);
  for (let i = 1; i <= 5; i++) l.push(i);
  assert.deepEqual(l.all(), [3, 4, 5]);
  assert.equal(l.dropped, 2);
  assert.equal(l.find((x) => x === 4), 4);
  l.clear();
  assert.deepEqual(l.all(), []);
  assert.equal(l.dropped, 0);
});

test("makeConsoleEntry truncates and redacts", () => {
  const suffix = "…[truncated]";
  const e = makeConsoleEntry({ type: "log", text: "x".repeat(20000), ts: 1 });
  assert.equal(e.text.length, TEXT_CAP + suffix.length);
  assert.ok(e.text.endsWith(suffix));
  const r = makeConsoleEntry({ type: "log", text: "see https://a.com/?token=t", url: "https://a.com/?token=u", stack: "at https://a.com/?token=s", ts: 1 });
  assert.match(r.text, /token=REDACTED/);
  assert.match(r.url!, /token=REDACTED/);
  assert.match(r.stack!, /token=REDACTED/);
});

test("makeConsoleEntry redacts before truncating", () => {
  const e = makeConsoleEntry({ type: "log", text: "x".repeat(TEXT_CAP - 10) + " https://a.com/?token=SECRETVALUE123", ts: 1 });
  assert.ok(!e.text.includes("SECRET"));
});

test("makeNetworkEntry redacts url", () => {
  const e = makeNetworkEntry({ requestId: "r", url: "https://a.com/?token=t", method: "GET", resourceType: "fetch", ts: 1 });
  assert.match(e.url, /token=REDACTED/);
});

test("queryConsole filters and limits", () => {
  const l = new RingLog<ConsoleEntry>();
  ["log", "error", "exception", "warning", "log"].forEach((t, i) => l.push(c(t, i === 3 ? "Boot done" : "m" + i, i)));
  assert.deepEqual(queryConsole(l, { onlyErrors: true }).entries.map((e) => e.type), ["error", "exception"]);
  assert.equal(queryConsole(l, { pattern: parsePattern("boot") }).matched, 1);
  const r = queryConsole(l, { limit: 2 });
  assert.equal(r.matched, 5);
  assert.deepEqual(r.entries.map((e) => e.ts), [3, 4]);
});

test("queryNetwork filters", () => {
  const l = new RingLog<NetworkEntry>();
  l.push(n({ requestId: "a", status: 200 }));
  l.push(n({ requestId: "b", status: 404 }));
  l.push(n({ requestId: "c", failed: "net::ERR_X" }));
  l.push(n({ requestId: "d" }));
  l.push(n({ requestId: "e", resourceType: "script", url: "https://a.com/?token=REDACTED" }));
  assert.deepEqual(queryNetwork(l, { onlyFailed: true }).entries.map((e) => e.requestId), ["b", "c"]);
  assert.equal(queryNetwork(l, { resourceType: "FETCH" }).matched, 4);
  assert.deepEqual(queryNetwork(l, { urlPattern: "REDACTED" }).entries.map((e) => e.requestId), ["e"]);
});

test("formatNetwork", () => {
  const entries = [n({ status: 404 }), n({ failed: "net::ERR_CONNECTION_REFUSED" }), n({})];
  const out = formatNetwork({ matched: 3, entries, dropped: 7, notes: ["note one", "note two"] });
  const lines = out.split("\n");
  assert.ok(lines[0].includes("3 matching, 3 shown"));
  assert.ok(lines[0].includes("7 older entries were dropped"));
  assert.equal(lines[1], "note one");
  assert.equal(lines[2], "note two");
  assert.ok(out.includes("404"));
  assert.ok(out.includes("failed net::ERR_CONNECTION_REFUSED"));
  assert.ok(out.includes("pending"));
  assert.ok(!formatNetwork({ matched: 0, entries: [], dropped: 0, notes: [] }).includes("dropped"));
});

test("formatConsole indents stack and shows source", () => {
  const out = formatConsole({
    matched: 1, dropped: 0, notes: [],
    entries: [{ type: "exception", text: "boom", url: "https://a.com/x.js", line: 3, column: 4, stack: "at f\nat g", ts: 0 }],
  });
  assert.ok(out.includes(`${timeOf(0)} [exception] boom (https://a.com/x.js:3:4)`));
  assert.ok(out.includes("\n    at f\n    at g"));
  assert.ok(formatConsole({ matched: 1, dropped: 0, notes: [], entries: [c("log", "hi")] }).includes("[log] hi"));
});

test("parsePattern", () => {
  assert.throws(() => parsePattern("("));
  assert.ok(parsePattern("AB").test("xab"));
  assert.ok(parsePattern("a".repeat(PATTERN_MAX)).test("a".repeat(PATTERN_MAX)));
  assert.throws(() => parsePattern("a".repeat(PATTERN_MAX + 1)), /longer than 200/);
});

test("timeOf is local HH:MM:SS.mmm and prefixes every entry line", () => {
  const ts = new Date(2026, 10, 2, 9, 5, 7, 42).getTime();
  assert.equal(timeOf(ts), "09:05:07.042");
  const net = formatNetwork({ matched: 1, entries: [n({ status: 200, ts })], dropped: 0, notes: ["note"] }).split("\n");
  assert.equal(net[1], "note");
  assert.equal(net[2], "09:05:07.042 GET 200 fetch https://a.com/");
  const con = formatConsole({ matched: 1, dropped: 0, notes: [], entries: [{ type: "exception", text: "boom", stack: "at f", ts }] }).split("\n");
  assert.equal(con[1], "09:05:07.042 [exception] boom");
  assert.equal(con[2], "    at f");
});

test("RingLog.find returns the newest match", () => {
  const l = new RingLog<{ id: string; v: number }>();
  l.push({ id: "a", v: 1 });
  l.push({ id: "a", v: 2 });
  assert.equal(l.find((e) => e.id === "a")?.v, 2);
});

test("query limit is clamped to >= 0", () => {
  const l = new RingLog<ConsoleEntry>();
  for (let i = 0; i < 3; i++) l.push(c("log", "m", i));
  assert.equal(queryConsole(l, { limit: 0 }).entries.length, 0);
  assert.equal(queryConsole(l, { limit: -2 }).entries.length, 0);
  assert.equal(queryConsole(l, { limit: -2 }).matched, 3);
  const nl = new RingLog<NetworkEntry>();
  nl.push(n({}));
  assert.equal(queryNetwork(nl, { limit: -5 }).entries.length, 0);
});

test("RingLog.clearSeen removes only the snapshot and keeps later entries", () => {
  const l = new RingLog<{ v: number }>(2);
  for (let i = 1; i <= 3; i++) l.push({ v: i });
  assert.equal(l.dropped, 1);
  const seen = l.all();
  l.push({ v: 4 });
  l.clearSeen(seen);
  assert.deepEqual(l.all().map((e) => e.v), [4]);
  assert.equal(l.dropped, 0);
});
