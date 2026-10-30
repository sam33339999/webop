import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFrame, FrameDecoder } from "../src/framing.ts";

test("frame roundtrip incl. split chunks", () => {
  const buf = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: "漢字" })]);
  const dec = new FrameDecoder();
  const out: unknown[] = [];
  for (let i = 0; i < buf.length; i++) out.push(...dec.push(buf.subarray(i, i + 1)));
  assert.deepEqual(out, [{ a: 1 }, { b: "漢字" }]);
});

test("length prefix is little-endian uint32", () => {
  const f = encodeFrame({ a: 1 });
  assert.equal(f.readUInt32LE(0), f.length - 4);
});

test("frame >1MB ext→host decodes", () => {
  const big = "x".repeat(1_500_000);
  const out = new FrameDecoder().push(encodeFrame({ big }));
  assert.deepEqual(out, [{ big }]);
});
