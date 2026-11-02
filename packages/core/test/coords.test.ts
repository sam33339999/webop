import { test } from "node:test";
import assert from "node:assert/strict";
import { fromViewport, toViewport } from "../src/coords.ts";

const ctx = { viewportWidth: 1280, viewportHeight: 800, screenshotWidth: 1280, screenshotHeight: 800 };
test("identity at scale 1", () => assert.deepEqual(toViewport(640, 400, ctx), { viewport: [640, 400] }));
const half = { viewportWidth: 1280, viewportHeight: 800, screenshotWidth: 640, screenshotHeight: 400 };
test("downscaled frame maps up", () => assert.deepEqual(toViewport(320, 200, half), { viewport: [640, 400] }));
test("origin ok", () => assert.deepEqual(toViewport(0, 0, half), { viewport: [0, 0] }));
test("last pixel ok", () => assert.ok("viewport" in toViewport(639, 399, half)));
test("+1 tolerance ok", () => assert.ok("viewport" in toViewport(641, 401, half)));
test("+2 is oob", () => assert.ok("oobError" in toViewport(642, 0, half)));
test("negative oob", () => assert.ok("oobError" in toViewport(-1, 5, half)));
test("NaN oob", () => assert.ok("oobError" in toViewport(NaN, 5, half)));
test("oob message names frame and full-resolution", () => {
  const r = toViewport(9999, 0, half) as { oobError: string };
  assert.match(r.oobError, /640x400/);
  assert.match(r.oobError, /full-resolution/);
});
test("fromViewport scales into the screenshot frame", () => assert.deepEqual(fromViewport(640, 400, half), [320, 200]));
test("fromViewport round-trips with toViewport", () => {
  const r = toViewport(123, 77, half);
  assert.ok("viewport" in r);
  const [bx, by] = fromViewport(r.viewport[0], r.viewport[1], half);
  assert.ok(Math.abs(bx - 123) <= 1 && Math.abs(by - 77) <= 1);
});
