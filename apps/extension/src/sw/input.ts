import { sendWithInject } from "./inject.ts";
import { isOwned } from "./sessions.ts";
import { send } from "./cdp.ts";
import { MOD_ALT, MOD_CTRL, MOD_META, MOD_SHIFT, parseCombo } from "./keys.ts";

const HOVER_WAIT_MS = 100;
const PRESS_RELEASE_MS = 12;
const MULTI_CLICK_GAP_MS = 100;
const WHEEL_TICK_PX = 100;
const DRAG_STEPS = 5;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Fire-and-forget: the overlay may not be injected yet (or the page may be restricted). */
function moveCursor(tabId: number, x: number, y: number): void {
  sendWithInject(tabId, { type: "webop:cursor", x, y }, isOwned).catch(() => {});
}

function mouse(tabId: number, params: Record<string, unknown>): Promise<unknown> {
  moveCursor(tabId, params.x as number, params.y as number);
  return send(tabId, "Input.dispatchMouseEvent", params);
}

export async function click(
  tabId: number,
  x: number,
  y: number,
  o: { button?: "left" | "right"; count?: 1 | 2 } = {},
): Promise<void> {
  const button = o.button ?? "left";
  const count = o.count ?? 1;
  const mask = button === "left" ? 1 : 2;
  await mouse(tabId, { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  await sleep(HOVER_WAIT_MS);
  for (let i = 1; i <= count; i++) {
    await mouse(tabId, { type: "mousePressed", x, y, button, buttons: mask, clickCount: i });
    await sleep(PRESS_RELEASE_MS);
    await mouse(tabId, { type: "mouseReleased", x, y, button, buttons: 0, clickCount: i });
    if (i < count) await sleep(MULTI_CLICK_GAP_MS);
  }
}

export async function hover(tabId: number, x: number, y: number): Promise<void> {
  await mouse(tabId, { type: "mouseMoved", x, y, button: "none", buttons: 0 });
}

export async function drag(tabId: number, from: [number, number], to: [number, number]): Promise<void> {
  await mouse(tabId, { type: "mouseMoved", x: from[0], y: from[1], button: "none", buttons: 0 });
  await sleep(HOVER_WAIT_MS);
  await mouse(tabId, { type: "mousePressed", x: from[0], y: from[1], button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= DRAG_STEPS; i++) {
    const x = from[0] + ((to[0] - from[0]) * i) / DRAG_STEPS;
    const y = from[1] + ((to[1] - from[1]) * i) / DRAG_STEPS;
    await mouse(tabId, { type: "mouseMoved", x, y, button: "left", buttons: 1 });
  }
  await mouse(tabId, { type: "mouseReleased", x: to[0], y: to[1], button: "left", buttons: 0, clickCount: 1 });
}

export async function typeText(tabId: number, text: string): Promise<void> {
  await send(tabId, "Input.insertText", { text });
}

/** Editing commands Chrome needs on macOS, where the same chord otherwise maps to a different action. */
function commandsFor(modifiers: number, key: string): string[] | undefined {
  if (modifiers === MOD_META || modifiers === MOD_CTRL) {
    if (key === "a") return ["selectAll"];
  }
  if (modifiers === MOD_META) {
    if (key === "c") return ["copy"];
    if (key === "x") return ["cut"];
    if (key === "v") return ["paste"];
    if (key === "z") return ["undo"];
  }
  if (modifiers === (MOD_META | MOD_SHIFT) && key === "z") return ["redo"];
  return undefined;
}

async function pressOne(tabId: number, combo: string): Promise<void> {
  const { modifiers, key } = parseCombo(combo);
  const printable = key.text !== undefined && key.text.length === 1 && key.text !== " " && key.text !== "\r";
  if (modifiers === 0 && printable) {
    await send(tabId, "Input.insertText", { text: key.text });
    return;
  }
  // Text is produced only for unmodified (or shift-only) chords; ctrl/alt/meta chords are shortcuts.
  const producesText = key.text !== undefined && (modifiers & (MOD_ALT | MOD_CTRL | MOD_META)) === 0;
  const base = {
    modifiers,
    key: key.key,
    code: key.code,
    windowsVirtualKeyCode: key.keyCode,
    nativeVirtualKeyCode: key.keyCode,
  };
  const commands = commandsFor(modifiers, key.key);
  await send(tabId, "Input.dispatchKeyEvent", {
    ...base,
    type: producesText ? "keyDown" : "rawKeyDown",
    ...(producesText ? { text: shiftText(key.text as string, modifiers) } : {}),
    ...(commands ? { commands } : {}),
  });
  await send(tabId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

function shiftText(text: string, modifiers: number): string {
  return modifiers & MOD_SHIFT ? text.toUpperCase() : text;
}

/** Space-separated chords are pressed in order. */
export async function pressKeys(tabId: number, combo: string): Promise<void> {
  for (const c of combo.trim().split(/\s+/)) await pressOne(tabId, c);
}

export async function scroll(
  tabId: number,
  x: number,
  y: number,
  dir: "up" | "down" | "left" | "right",
  ticks: number,
): Promise<void> {
  const px = ticks * WHEEL_TICK_PX;
  const deltaX = dir === "left" ? -px : dir === "right" ? px : 0;
  const deltaY = dir === "up" ? -px : dir === "down" ? px : 0;
  await mouse(tabId, { type: "mouseWheel", x, y, deltaX, deltaY, button: "none", buttons: 0 });
}
