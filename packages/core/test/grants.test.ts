import { test } from "node:test";
import assert from "node:assert/strict";
import { covers, decide, levelFor } from "../src/grants.ts";
import type { Policy } from "../src/grants.ts";

const policy = (over: Partial<Policy> = {}): Policy => ({
  always: {},
  once: {},
  deny: [],
  jsEnabled: true,
  ...over,
});

test("levelFor maps tools and actions to levels", () => {
  assert.equal(levelFor("computer", "screenshot"), "read");
  assert.equal(levelFor("computer", "left_click"), "act");
  assert.equal(levelFor("navigate"), "read");
  assert.equal(levelFor("tabs_create"), "read");
  assert.equal(levelFor("read_page"), "read");
  assert.equal(levelFor("tabs_close"), null);
  assert.equal(levelFor("tabs_list"), null);
  assert.equal(levelFor("javascript"), "javascript");
});

test("covers: act implies read; javascript only itself", () => {
  assert.equal(covers(["act"], "read"), true);
  assert.equal(covers(["read"], "act"), false);
  assert.equal(covers(["act"], "javascript"), false);
  assert.equal(covers(["javascript"], "javascript"), true);
  assert.equal(covers(["javascript"], "read"), false);
});

test("decide", () => {
  assert.equal(decide(policy(), null, "read"), "deny");
  assert.equal(
    decide(policy({ deny: ["a.com"], always: { "a.com": ["act"] } }), "a.com", "read"),
    "deny",
  );
  assert.equal(decide(policy({ always: { "a.com": ["act"] } }), "a.com", "read"), "allow");
  assert.equal(decide(policy({ once: { "a.com": ["read"] } }), "a.com", "read"), "allow");
  assert.equal(
    decide(policy({ jsEnabled: false, always: { "a.com": ["javascript"] } }), "a.com", "javascript"),
    "deny",
  );
  assert.equal(decide(policy(), "a.com", "read"), "ask");
  assert.equal(decide(policy({ once: { "a.com": ["read"] } }), "a.com", "act"), "ask");
  assert.equal(decide(policy(), "a.com", "javascript"), "ask");
});

test("levelFor is fail-closed on unknown tools", () => {
  assert.throws(() => levelFor("browser_navigate"), /Unknown tool: browser_navigate/);
  assert.throws(() => levelFor("nope"), /Unknown tool: nope/);
  assert.equal(levelFor("computer"), "act");
});

test("deny beats once; prototype-named sites do not throw", () => {
  assert.equal(decide(policy({ deny: ["a.com"], once: { "a.com": ["act"] } }), "a.com", "read"), "deny");
  assert.equal(decide(policy(), "__proto__", "read"), "ask");
  assert.equal(decide(policy(), "constructor", "act"), "ask");
  assert.equal(decide(policy({ deny: ["__proto__"] }), "__proto__", "read"), "deny");
});
