import { test } from "node:test";
import assert from "node:assert/strict";
import { planFrames, stepCaption, GIF_FRAME_MS, GIF_LAST_FRAME_MS } from "../src/gif.ts";
import type { FrameMeta } from "../src/gif.ts";

const f = (tabId: number, step: FrameMeta["step"], site = "localhost"): FrameMeta => ({ tabId, site, step });

test("planFrames: click then type on same tab", () => {
  const p = planFrames([
    f(1, { kind: "screenshot" }),
    f(1, { kind: "left_click", point: [100, 50] }),
    f(1, { kind: "type", chars: 14 }),
  ]);
  assert.ok(p[0]!.caption.includes("點擊 (100, 50)"));
  assert.deepEqual(p[0]!.marker, { point: [100, 50] });
  assert.ok(p[1]!.caption.includes("輸入 14 個字元"));
  assert.equal(p[1]!.marker, undefined);
  assert.ok(p[2]!.caption.includes("完成"));
  assert.deepEqual(p.map((x) => x.durationMs), [GIF_FRAME_MS, GIF_FRAME_MS, GIF_LAST_FRAME_MS]);
  assert.ok(p[0]!.caption.startsWith("1/3 · "));
  assert.ok(p[0]!.caption.endsWith(" · localhost"));
  assert.deepEqual(p.map((x) => x.frame), [0, 1, 2]);
});

test("planFrames: rule one beats the own-step fallback on tab switch", () => {
  const p = planFrames([
    f(1, { kind: "screenshot" }),
    f(2, { kind: "tabs_create", url: "https://a.com/" }),
    f(2, { kind: "left_click", point: [1, 2] }),
  ]);
  assert.ok(!p[0]!.caption.includes("開新分頁"));
  assert.equal(p[0]!.caption, "1/3 ·  · localhost");
  assert.ok(p[1]!.caption.includes("點擊 (1, 2)"));
  assert.ok(!p[1]!.caption.includes("開新分頁"));
});

test("planFrames: own-step fallback when tab changed and frame unclaimed", () => {
  const p = planFrames([
    f(1, { kind: "screenshot" }),
    f(2, { kind: "tabs_create", url: "https://a.com/" }),
    f(2, { kind: "screenshot" }),
  ]);
  assert.ok(p[1]!.caption.includes("開新分頁 a.com/"));
  assert.ok(p[2]!.caption.includes("完成"));
});

test("planFrames: first frame falls back to own step", () => {
  const p = planFrames([f(1, { kind: "navigate", url: "https://a.com/x" }), f(1, { kind: "screenshot" })]);
  assert.ok(p[0]!.caption.includes("前往 a.com/x"));
});

test("navigate url is redacted", () => {
  assert.equal(
    stepCaption({ kind: "navigate", url: "https://a.com/p?token=t" }),
    "前往 a.com/p?token=REDACTED",
  );
});

test("long url truncated to 60 chars plus ellipsis", () => {
  const c = stepCaption({ kind: "navigate", url: "https://a.com/" + "x".repeat(100) })!;
  assert.equal(c, "前往 " + ("a.com/" + "x".repeat(100)).slice(0, 60) + "…");
});

test("drag marker has point and to", () => {
  const p = planFrames([
    f(1, { kind: "screenshot" }),
    f(1, { kind: "left_click_drag", point: [1.4, 2.6], to: [30, 40] }),
  ]);
  assert.deepEqual(p[0]!.marker, { point: [1, 3], to: [30, 40] });
  assert.ok(p[0]!.caption.includes("拖曳 (1, 3) → (30, 40)"));
});

test("single screenshot frame", () => {
  assert.deepEqual(planFrames([f(1, { kind: "screenshot" }, "site")]), [
    { frame: 0, caption: "1/1 · 完成 · site", durationMs: GIF_LAST_FRAME_MS },
  ]);
});

test("stepCaption variants", () => {
  assert.equal(stepCaption({ kind: "screenshot" }), null);
  assert.equal(stepCaption({ kind: "left_click", ref: "ref_12" }), "點擊 ref_12");
  assert.equal(stepCaption({ kind: "right_click", point: [1, 2] }), "右鍵點擊 (1, 2)");
  assert.equal(stepCaption({ kind: "double_click", point: [1, 2] }), "雙擊 (1, 2)");
  assert.equal(stepCaption({ kind: "hover", ref: "ref_3" }), "滑鼠移到 ref_3");
  assert.equal(stepCaption({ kind: "key", keys: "ctrl+a" }), "按鍵 ctrl+a");
  assert.equal(stepCaption({ kind: "scroll", direction: "down", amount: 3 }), "捲動 ↓ 3");
  assert.equal(stepCaption({ kind: "scroll", direction: "left", amount: 1 }), "捲動 ← 1");
  assert.equal(stepCaption({ kind: "scroll_to", ref: "ref_12" }), "捲動到 ref_12");
  assert.equal(stepCaption({ kind: "form_input", ref: "ref_12" }), "表單欄位 ref_12 設值");
  assert.equal(stepCaption({ kind: "tabs_create", url: "https://a.com/b" }), "開新分頁 a.com/b");
});
