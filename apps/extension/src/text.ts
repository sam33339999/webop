// Page-text content script: the main content of the page as plain text (browser_get_page_text).
// Injected on demand alongside ax.js; the guard keeps a second injection into the same document inert.
type Guard = { alive: () => boolean };
const textGuard = window as unknown as { __wopText?: Guard };
if (!textGuard.__wopText?.alive()) {
textGuard.__wopText = { alive: () => !!chrome.runtime?.id };

type TextMessage = { type: "webop:page_text"; max_chars?: number };

const DEFAULT_MAX_CHARS = 50000;
const SKIP = "nav, header, footer, aside, script, style, noscript, template, svg, [aria-hidden=true], [hidden]";
const BLOCK = new Set([
  "ADDRESS", "ARTICLE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FORM",
  "H1", "H2", "H3", "H4", "H5", "H6", "HR", "LI", "MAIN", "OL", "P", "PRE", "SECTION", "TABLE", "TD", "TH", "TR", "UL",
]);

/** `main`, then `[role=main]`, then the `article` with the most text, then `body`. */
function contentRoot(): Element {
  const main = document.querySelector("main") ?? document.querySelector("[role=main]");
  if (main) return main;
  let best: Element | null = null;
  let bestLen = -1;
  for (const a of document.querySelectorAll("article")) {
    const len = (a.textContent ?? "").length;
    if (len > bestLen) { best = a; bestLen = len; }
  }
  return best ?? document.body ?? document.documentElement;
}

function hidden(el: Element): boolean {
  if (el.matches(SKIP)) return true;
  const s = getComputedStyle(el);
  return s.display === "none" || s.visibility === "hidden";
}

function collect(node: Node, out: string[], pre = false): void {
  if (node.nodeType === Node.TEXT_NODE) {
    // Source line breaks are just whitespace, as the browser renders them (except inside <pre>).
    const t = node.textContent ?? "";
    out.push(pre ? t : t.replace(/\s+/g, " "));
    return;
  }
  if (!(node instanceof Element) || hidden(node)) return;
  // Form values are not page text; a password value must never leave the page.
  if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) return;
  const block = BLOCK.has(node.tagName);
  if (block) out.push("\n");
  const inPre = pre || node.tagName === "PRE";
  if (node.tagName === "BR") out.push("\n");
  for (const child of node.childNodes) collect(child, out, inPre);
  if (block) out.push("\n");
}

function normalize(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pageText(maxChars: number): { text: string; truncated: boolean } {
  const out: string[] = [];
  collect(contentRoot(), out);
  const body = normalize(out.join(""));
  if (body.length <= maxChars) return { text: body, truncated: false };
  return { text: body.slice(0, maxChars), truncated: true };
}

chrome.runtime.onMessage.addListener((msg: TextMessage, _sender, sendResponse) => {
  if (msg?.type === "webop:page_text") {
    const max = typeof msg.max_chars === "number" && msg.max_chars > 0 ? Math.floor(msg.max_chars) : DEFAULT_MAX_CHARS;
    sendResponse(pageText(max));
  }
  return false;
});
}
