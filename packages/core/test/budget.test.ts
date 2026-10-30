import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BUDGET, fitBudget, planCapture } from "../src/budget.ts";

const tokens = (w: number, h: number) => Math.ceil(w / 28) * Math.ceil(h / 28);
test("small image unchanged", () => assert.deepEqual(fitBudget(800, 600, DEFAULT_BUDGET), [800, 600]));
for (const [w, h] of [[2560, 1600], [3840, 2160], [1280, 8000], [1568, 1568]] as const) {
  test(`fits ${w}x${h}`, () => {
    const [a, b] = fitBudget(w, h, DEFAULT_BUDGET);
    assert.ok(a <= 1568 && b <= 1568 && tokens(a, b) <= 1568);
    assert.ok(Math.abs(a / b - w / h) < 0.02);
  });
}
test("planCapture dpr2 scales down to budget", () => {
  const p = planCapture(1280, 800, 2);
  assert.ok(p.clipScale > 0 && p.clipScale <= 1);
  assert.ok(tokens(p.outWidth, p.outHeight) <= 1568);
});
test("planCapture never upscales", () => assert.equal(planCapture(400, 300, 1).clipScale, 1));
test("planCapture dpr2 small viewport halves to css size", () => {
  const p = planCapture(400, 300, 2);
  assert.equal(p.outWidth, 800);
  assert.equal(p.clipScale, 1);
});
test("planCapture extreme aspect stays within budget", () => {
  const p = planCapture(90, 2000, 1);
  assert.ok(Math.max(p.outWidth, p.outHeight) <= 1568 && tokens(p.outWidth, p.outHeight) <= 1568);
});
test("planCapture grid stays within budget", () => {
  for (const w of [90, 200, 500]) for (const h of [2000, 5000, 8000]) for (const dpr of [1, 2]) {
    const p = planCapture(w, h, dpr);
    assert.ok(Math.max(p.outWidth, p.outHeight) <= 1568 && tokens(p.outWidth, p.outHeight) <= 1568, `${w}x${h}@${dpr}`);
  }
});
