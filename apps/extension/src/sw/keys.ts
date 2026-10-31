export interface KeySpec {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

export const MOD_ALT = 1;
export const MOD_CTRL = 2;
export const MOD_META = 4;
export const MOD_SHIFT = 8;

const MODIFIERS: Record<string, number> = {
  alt: MOD_ALT, option: MOD_ALT,
  ctrl: MOD_CTRL, control: MOD_CTRL,
  meta: MOD_META, cmd: MOD_META, command: MOD_META,
  shift: MOD_SHIFT,
};

const NAMED: Record<string, KeySpec> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
};

const PUNCTUATION: Array<[string, string, string, number]> = [
  // [char, name, code, keyCode]
  ["/", "slash", "Slash", 191],
  [".", "period", "Period", 190],
  [",", "comma", "Comma", 188],
  [";", "semicolon", "Semicolon", 186],
  ["'", "quote", "Quote", 222],
  ["[", "bracketleft", "BracketLeft", 219],
  ["]", "bracketright", "BracketRight", 221],
  ["\\", "backslash", "Backslash", 220],
  ["-", "minus", "Minus", 189],
  ["=", "equal", "Equal", 187],
  ["`", "backquote", "Backquote", 192],
];
for (const [char, name, code, keyCode] of PUNCTUATION) {
  const spec: KeySpec = { key: char, code, keyCode, text: char };
  NAMED[char] = spec;
  NAMED[name] = spec;
}
for (let n = 1; n <= 12; n++) NAMED[`f${n}`] = { key: `F${n}`, code: `F${n}`, keyCode: 111 + n };

function keyFor(token: string): KeySpec {
  const named = NAMED[token];
  if (named) return named;
  if (/^[a-z]$/.test(token)) {
    return { key: token, code: `Key${token.toUpperCase()}`, keyCode: token.toUpperCase().charCodeAt(0), text: token };
  }
  if (/^[0-9]$/.test(token)) return { key: token, code: `Digit${token}`, keyCode: token.charCodeAt(0), text: token };
  throw new Error(`Unsupported key: ${token}`);
}

/** Parses one chord such as "Enter", "ctrl+a" or "cmd+shift+t". Throws on unknown tokens. */
export function parseCombo(combo: string): { modifiers: number; key: KeySpec } {
  const tokens = combo.trim().toLowerCase().split("+").map((t) => t.trim());
  if (tokens.length === 0 || tokens.some((t) => t === "")) throw new Error(`Invalid key combo: ${combo}`);
  const last = tokens[tokens.length - 1];
  let modifiers = 0;
  for (const t of tokens.slice(0, -1)) {
    const m = MODIFIERS[t];
    if (m === undefined) throw new Error(`Unknown modifier: ${t}`);
    modifiers |= m;
  }
  return { modifiers, key: keyFor(last) };
}
