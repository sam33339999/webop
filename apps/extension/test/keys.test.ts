import { test } from "node:test";
import assert from "node:assert/strict";
import { MOD_META, parseCombo } from "../src/sw/keys.ts";

test("single punctuation characters", () => {
  assert.deepEqual(parseCombo("/"), { modifiers: 0, key: { key: "/", code: "Slash", keyCode: 191, text: "/" } });
  const table: Array<[string, string, number]> = [
    [".", "Period", 190], [",", "Comma", 188], [";", "Semicolon", 186], ["'", "Quote", 222],
    ["[", "BracketLeft", 219], ["]", "BracketRight", 221], ["\\", "Backslash", 220],
    ["-", "Minus", 189], ["=", "Equal", 187], ["`", "Backquote", 192],
  ];
  for (const [ch, code, keyCode] of table) {
    assert.deepEqual(parseCombo(ch).key, { key: ch, code, keyCode, text: ch });
  }
});

test("punctuation names map to the same specs", () => {
  const names: Record<string, string> = {
    slash: "/", period: ".", comma: ",", minus: "-", equal: "=", backquote: "`", backslash: "\\",
    semicolon: ";", quote: "'", bracketleft: "[", bracketright: "]",
  };
  for (const [name, ch] of Object.entries(names)) assert.deepEqual(parseCombo(name), parseCombo(ch), name);
});

test("modifier with punctuation", () => {
  const r = parseCombo("cmd+/");
  assert.equal(r.modifiers, MOD_META);
  assert.equal(r.modifiers, 4);
  assert.equal(r.key.code, "Slash");
  assert.equal(parseCombo("ctrl+-").key.code, "Minus");
});

test("function keys f1-f12", () => {
  assert.deepEqual(parseCombo("f1").key, { key: "F1", code: "F1", keyCode: 112 });
  assert.deepEqual(parseCombo("F12").key, { key: "F12", code: "F12", keyCode: 123 });
  assert.throws(() => parseCombo("f13"), /Unsupported key/);
});

test("existing keys still work and unknown ones throw", () => {
  assert.equal(parseCombo("ctrl+a").key.code, "KeyA");
  assert.throws(() => parseCombo("nope"), /Unsupported key/);
});
