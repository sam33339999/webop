// Accessibility-tree content script: builds a text AX tree and hands out stable `ref_N` handles for elements.
// Injected on demand (and again after reloads); the flag keeps a second injection into the same document inert.
// The guard is live only while this extension context is: after an extension reload the old context is orphaned (chrome.runtime.id is gone), so a fresh injection takes over.
type Guard = { alive: () => boolean; dispose?: () => void };
const guardHolder = window as unknown as { __wopAx?: Guard };
if (guardHolder.__wopAx?.alive()) {
  // already running in this document
} else {
guardHolder.__wopAx?.dispose?.();
guardHolder.__wopAx = { alive: () => !!chrome.runtime?.id };
type AxMessage =
  | { type: "webop:read_page"; filter?: "interactive"; ref_id?: string; max_chars?: number; ref_base?: number }
  | { type: "webop:ref_point"; ref: string }
  | { type: "webop:frame_check"; x?: number; y?: number };

const MAX_DEPTH = 15;
const MAX_NODES = 10000;
const DEFAULT_MAX_CHARS = 50000;
const TEXT_LIMIT = 100;

// Numbering is monotonic for the lifetime of this document; a reload re-runs the script and starts fresh.
let counter = 0;
const refMap = new Map<string, WeakRef<Element>>();
const reverseMap = new WeakMap<Element, string>();

function refFor(el: Element): string {
  let ref = reverseMap.get(el);
  if (ref === undefined) {
    ref = `ref_${++counter}`;
    reverseMap.set(el, ref);
    refMap.set(ref, new WeakRef(el));
  }
  return ref;
}

function lookup(ref: string): Element | null {
  const el = refMap.get(ref)?.deref();
  if (el === undefined || !document.contains(el)) {
    refMap.delete(ref);
    return null;
  }
  return el;
}

function pruneStaleRefs(): void {
  for (const ref of [...refMap.keys()]) lookup(ref);
}

const TAG_ROLES: Record<string, string> = {
  a: "link", button: "button", select: "select", textarea: "textbox", option: "option", img: "img",
  h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
  nav: "navigation", main: "main", header: "banner", footer: "contentinfo", aside: "complementary",
  form: "form", ul: "list", ol: "list", li: "listitem", table: "table", tr: "row", td: "cell", th: "columnheader",
  summary: "button", dialog: "dialog",
};
const INPUT_ROLES: Record<string, string> = {
  button: "button", submit: "button", reset: "button", image: "button", checkbox: "checkbox", radio: "radio",
  range: "slider", search: "searchbox",
};
const INTERACTIVE_ROLES = new Set([
  "link", "button", "select", "textbox", "searchbox", "checkbox", "radio", "slider", "combobox", "option",
  "menuitem", "tab", "switch", "spinbutton",
]);
const LEAF_ROLES = new Set(["button", "link", "option", "textbox", "searchbox", "checkbox", "radio", "tab", "menuitem"]);
const TEXT_NAMED_ROLES = new Set(["heading"]);
const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "head", "svg"]);

function roleOf(el: Element): string {
  const attr = el.getAttribute("role")?.trim().split(/\s+/)[0];
  if (attr) return attr;
  const tag = el.tagName.toLowerCase();
  if (tag === "input") {
    const type = (el as HTMLInputElement).type || "text";
    return INPUT_ROLES[type] ?? "textbox";
  }
  if (tag === "a" && !el.hasAttribute("href")) return "generic";
  return TAG_ROLES[tag] ?? "generic";
}

function isInteractive(el: Element, role: string): boolean {
  if (INTERACTIVE_ROLES.has(role)) return true;
  return el.hasAttribute("onclick") || el.getAttribute("contenteditable") === "" || el.getAttribute("contenteditable") === "true";
}

function isVisible(el: Element): boolean {
  const s = getComputedStyle(el);
  if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse" || Number(s.opacity) === 0) return false;
  const h = el as HTMLElement;
  // display:contents boxes have no size of their own; judge them by their children instead.
  if (s.display !== "contents" && h.offsetWidth === 0 && h.offsetHeight === 0 && el.getClientRects().length === 0) return false;
  return true;
}

function inViewport(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
}

function clip(s: string, n = TEXT_LIMIT): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}...` : t;
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function nameOf(el: Element, role: string): string {
  const label = el.getAttribute("aria-label");
  if (label?.trim()) return clip(label);
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    const text = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
    if (text.trim()) return clip(text);
  }
  const labels = (el as HTMLInputElement).labels;
  if (labels && labels.length > 0) {
    const own = [...labels].map((l) => labelText(l, el)).join(" ");
    if (own.trim()) return clip(own);
  }
  const alt = el.getAttribute("alt");
  if (alt?.trim()) return clip(alt);
  const tag = el.tagName.toLowerCase();
  if (tag === "input") {
    const i = el as HTMLInputElement;
    if (role === "button" && i.value && !isSensitive(el)) return clip(i.value);
    return clip(i.placeholder || el.getAttribute("title") || "");
  }
  if (tag === "textarea") return clip((el as HTMLTextAreaElement).placeholder || el.getAttribute("title") || "");
  const title = el.getAttribute("title");
  if (tag === "select") return clip(title ?? "");
  if (role === "link" || role === "button" || role === "option" || role === "heading" || role === "tab" || role === "menuitem") {
    const text = clip(el.textContent ?? "");
    if (text) return text;
  }
  return clip(title ?? "");
}

/** Text of a <label>, excluding the control nested inside it. */
function labelText(label: Element, control: Element): string {
  let out = "";
  for (const node of label.childNodes) {
    if (node === control || (node instanceof Element && node.contains(control))) continue;
    out += node.textContent ?? "";
  }
  return out;
}

function isSensitive(el: Element): boolean {
  const type = (el as HTMLInputElement).type;
  if (type === "password" || type === "hidden") return true;
  const ac = (el.getAttribute("autocomplete") ?? "").toLowerCase();
  return /current-password|new-password|one-time-code|(^|\s)cc-/.test(ac);
}

function attrsOf(el: Element, role: string): string {
  const parts: string[] = [];
  const tag = el.tagName.toLowerCase();
  const href = el.getAttribute("href");
  if (tag === "a" && href) parts.push(`href=${quote(href)}`);
  if (tag === "input") {
    const i = el as HTMLInputElement;
    parts.push(`type=${quote(i.type)}`);
    if (i.placeholder) parts.push(`placeholder=${quote(clip(i.placeholder))}`);
    if (role === "checkbox" || role === "radio") parts.push(i.checked ? "(checked)" : "(unchecked)");
    else if (role === "textbox" || role === "searchbox" || role === "slider") {
      if (isSensitive(el)) parts.push(`value=${quote("[value redacted]")}`);
      else if (i.value) parts.push(`value=${quote(clip(i.value))}`);
    }
  } else if (tag === "textarea") {
    const t = el as HTMLTextAreaElement;
    if (t.placeholder) parts.push(`placeholder=${quote(clip(t.placeholder))}`);
    if (isSensitive(el)) parts.push(`value=${quote("[value redacted]")}`);
    else if (t.value) parts.push(`value=${quote(clip(t.value))}`);
  } else if (tag === "option") {
    const o = el as HTMLOptionElement;
    // Sensitivity lives on the owning <select> (autocomplete), so options inherit it.
    const owner = o.closest("select");
    if (owner && isSensitive(owner)) parts.push(`value=${quote("[value redacted]")}`);
    else {
      parts.push(`value=${quote(clip(o.value))}`);
      if (o.selected) parts.push("(selected)");
    }
  }
  if ((el as HTMLButtonElement).disabled) parts.push("(disabled)");
  return parts.join(" ");
}

interface Walk { lines: string[]; nodes: number; interactiveOnly: boolean }

function emit(w: Walk, depth: number, text: string): void {
  w.lines.push(`${" ".repeat(depth)}${text}`);
}

function walk(el: Element, depth: number, w: Walk): void {
  if (w.nodes >= MAX_NODES || depth > MAX_DEPTH) return;
  if (SKIP_TAGS.has(el.tagName.toLowerCase())) return;
  // <option> boxes are not rendered, so visibility is judged on the owning <select> (already checked).
  if (el.tagName !== "OPTION" && !isVisible(el)) return;
  w.nodes++;
  const role = roleOf(el);
  const interactive = isInteractive(el, role);
  const tag = el.tagName.toLowerCase();
  const semantic = role !== "generic";
  const show = w.interactiveOnly ? interactive && inViewport(el) : semantic || interactive;
  let childDepth = depth;
  if (show) {
    const name = nameOf(el, role);
    const attrs = attrsOf(el, role);
    emit(w, depth, `${role}${name ? ` ${quote(name)}` : ""} [${refFor(el)}]${attrs ? ` ${attrs}` : ""}`);
    childDepth = depth + 1;
  }
  // Leaf-like controls already carry their text in the name; only <select> needs its options.
  if (tag === "select") {
    for (const opt of (el as HTMLSelectElement).options) walk(opt, childDepth, w);
    return;
  }
  if (show && LEAF_ROLES.has(role)) return;
  if (tag === "input") return;
  // Roles whose accessible name already is their text must not repeat it as child text nodes.
  const textInName = show && TEXT_NAMED_ROLES.has(role);
  for (const node of el.childNodes) {
    if (w.nodes >= MAX_NODES) return;
    if (node instanceof Element) walk(node, childDepth, w);
    else if (node.nodeType === Node.TEXT_NODE && !w.interactiveOnly && !textInName) {
      const text = clip(node.textContent ?? "");
      if (text) { w.nodes++; emit(w, childDepth, `text ${quote(text)}`); }
    }
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max);
  const head = text.slice(0, cut > 0 ? cut : max);
  return `${head}\n[truncated: output exceeded max_chars=${max}]`;
}

function readPage(msg: Extract<AxMessage, { type: "webop:read_page" }>): { text: string; counter: number } | { error: "stale_ref" } {
  pruneStaleRefs();
  // The service worker remembers the highest number issued in this tab, so numbers never repeat across reloads.
  if (typeof msg.ref_base === "number") counter = Math.max(counter, msg.ref_base);
  const w: Walk = { lines: [], nodes: 0, interactiveOnly: msg.filter === "interactive" };
  let root: Element | null = document.body ?? document.documentElement;
  if (msg.ref_id !== undefined) {
    root = lookup(msg.ref_id);
    if (!root) return { error: "stale_ref" };
  }
  if (root) walk(root, 0, w);
  const max = typeof msg.max_chars === "number" && msg.max_chars > 0 ? msg.max_chars : DEFAULT_MAX_CHARS;
  const text = w.lines.join("\n");
  return { text: truncate(text === "" ? "(empty page)" : text, max), counter };
}

function refPoint(ref: string): { x: number; y: number } | { error: "stale_ref"; message?: string } {
  const el = lookup(ref);
  if (!el) return { error: "stale_ref" };
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  if (!isVisible(el) || r.width === 0 || r.height === 0) {
    return { error: "stale_ref", message: "target is not visible or has no layout box" };
  }
  const x = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
  const y = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
  const hit = document.elementFromPoint(x, y);
  if (!hit || !(hit === el || el.contains(hit))) {
    return { error: "stale_ref", message: "target is covered or not hit-testable" };
  }
  return { x, y };
}

type FrameVerdict = { ok: true } | { ok: false; src: string };

/**
 * Is the input target (the element at x,y, or the focused element when no point is given) inside a frame whose
 * content we cannot vouch for? Same-origin frames are descended into (their nested frames count too);
 * a frame whose document is unreachable is cross-origin and therefore reported with its src.
 */
function frameCheck(x?: number, y?: number): FrameVerdict {
  let doc: Document = document;
  let px = x;
  let py = y;
  for (let depth = 0; depth < 8; depth++) {
    const el: Element | null = px === undefined || py === undefined ? doc.activeElement : doc.elementFromPoint(px, py);
    if (!el || (el.tagName !== "IFRAME" && el.tagName !== "FRAME")) return { ok: true };
    const frame = el as HTMLIFrameElement;
    let inner: Document | null = null;
    try { inner = frame.contentDocument; } catch { inner = null; }
    if (!inner) return { ok: false, src: frame.src || frame.getAttribute("src") || "" };
    if (px !== undefined && py !== undefined) {
      const r = frame.getBoundingClientRect();
      px -= r.left + frame.clientLeft;
      py -= r.top + frame.clientTop;
    }
    doc = inner;
  }
  return { ok: false, src: "" };
}

chrome.runtime.onMessage.addListener((msg: AxMessage, _sender, sendResponse) => {
  if (msg?.type === "webop:read_page") {
    sendResponse(readPage(msg));
  } else if (msg?.type === "webop:ref_point") {
    sendResponse(refPoint(msg.ref));
  } else if (msg?.type === "webop:frame_check") {
    sendResponse(frameCheck(msg.x, msg.y));
  }
  return false;
});
}
