import { redactUrl } from "./redact.ts";

export const GIF_MAX_FRAMES = 50;
export const GIF_FRAME_MS = 1500;
export const GIF_LAST_FRAME_MS = 3000;
export const GIF_MAX_WIDTH = 1280;

/** Coordinates in the space of the screenshot taken BEFORE the action. */
export type Point = [number, number];

export type GifStep =
  | { kind: "screenshot" }
  | { kind: "left_click" | "right_click" | "double_click" | "hover"; point?: Point; ref?: string }
  | { kind: "left_click_drag"; point?: Point; to?: Point }
  | { kind: "type"; chars: number }
  | { kind: "key"; keys: string }
  | { kind: "scroll"; point?: Point; direction: "up" | "down" | "left" | "right"; amount: number }
  | { kind: "scroll_to"; ref: string }
  | { kind: "form_input"; ref: string }
  | { kind: "navigate" | "tabs_create"; url: string };

export type FrameMeta = { tabId: number; site: string; step: GifStep };
export type PlannedFrame = {
  frame: number;
  caption: string;
  marker?: { point: Point; to?: Point };
  durationMs: number;
};

const MAX_URL_CHARS = 60;
const ARROWS = { up: "↑", down: "↓", left: "←", right: "→" } as const;

const fmt = (p: Point): string => `(${Math.round(p[0])}, ${Math.round(p[1])})`;
const target = (s: { point?: Point; ref?: string }): string =>
  s.ref !== undefined ? s.ref : s.point ? fmt(s.point) : "";

function shortUrl(url: string): string {
  const bare = redactUrl(url).replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  return bare.length > MAX_URL_CHARS ? bare.slice(0, MAX_URL_CHARS) + "…" : bare;
}

const withTarget = (label: string, s: { point?: Point; ref?: string }): string => {
  const t = target(s);
  return t ? `${label} ${t}` : label;
};

/** Caption for a step; never includes typed text (only its length). screenshot has none. */
export function stepCaption(step: GifStep): string | null {
  switch (step.kind) {
    case "screenshot":
      return null;
    case "left_click":
      return withTarget("點擊", step);
    case "right_click":
      return withTarget("右鍵點擊", step);
    case "double_click":
      return withTarget("雙擊", step);
    case "hover":
      return withTarget("滑鼠移到", step);
    case "left_click_drag":
      return step.point && step.to ? `拖曳 ${fmt(step.point)} → ${fmt(step.to)}` : "拖曳";
    case "type":
      return `輸入 ${step.chars} 個字元`;
    case "key":
      return `按鍵 ${step.keys}`;
    case "scroll":
      return `捲動 ${ARROWS[step.direction]} ${step.amount}`;
    case "scroll_to":
      return `捲動到 ${step.ref}`;
    case "form_input":
      return `表單欄位 ${step.ref} 設值`;
    case "navigate":
      return `前往 ${shortUrl(step.url)}`;
    case "tabs_create":
      return `開新分頁 ${shortUrl(step.url)}`;
  }
}

function markerOf(step: GifStep): PlannedFrame["marker"] {
  if (step.kind === "left_click_drag") {
    if (!step.point) return undefined;
    const point: Point = [Math.round(step.point[0]), Math.round(step.point[1])];
    return step.to ? { point, to: [Math.round(step.to[0]), Math.round(step.to[1])] } : { point };
  }
  if ("point" in step && step.point) {
    return { point: [Math.round(step.point[0]), Math.round(step.point[1])] };
  }
  return undefined;
}

/**
 * Decide caption, click marker and duration for each recorded frame.
 *
 * A frame shows the action that is ABOUT to happen (frame i+1's step), because
 * the marker coordinates belong to the screenshot taken before the action.
 *
 * Rule 1 (wins): frame i shows frame i+1's step when i+1 exists, is on the same
 * tab and has a caption.
 * Rule 2 (fallback): otherwise, if frame i's own step was not drawn on frame i-1
 * (i = 0 or the tab differs) and has a caption, frame i shows its own step.
 * Rule 1 takes priority: with [A screenshot, B tabs_create, B left_click], frame 1
 * shows the click (rule 1) and not its own "開新分頁"; frame 0 stays empty because
 * frame 1 is on another tab.
 * The last frame with no caption reads "完成"; other empty frames keep an empty caption.
 */
export function planFrames(frames: FrameMeta[]): PlannedFrame[] {
  const n = frames.length;
  return frames.map((cur, i) => {
    const next = frames[i + 1];
    const prev = frames[i - 1];
    let caption: string | null = null;
    let marker: PlannedFrame["marker"];
    const nextCaption = next && next.tabId === cur.tabId ? stepCaption(next.step) : null;
    if (next && nextCaption !== null) {
      caption = nextCaption;
      marker = markerOf(next.step);
    } else if (!prev || prev.tabId !== cur.tabId) {
      caption = stepCaption(cur.step);
    }
    if (caption === null && i === n - 1) caption = "完成";
    const body = caption ?? "";
    const planned: PlannedFrame = {
      frame: i,
      caption: `${i + 1}/${n} · ${body} · ${cur.site}`,
      durationMs: i === n - 1 ? GIF_LAST_FRAME_MS : GIF_FRAME_MS,
    };
    if (marker) planned.marker = marker;
    return planned;
  });
}
