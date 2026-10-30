// Phantom cursor and glow overlay. Lives in a closed-style shadow root so page CSS cannot touch it.
type OverlayMessage =
  | { type: "webop:cursor"; x: number; y: number }
  | { type: "webop:overlay"; hidden: boolean }
  | { type: "webop:glow"; on: boolean; color: string };

const host = document.createElement("div");
host.style.cssText = "all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483646;";
const root = host.attachShadow({ mode: "closed" });
root.innerHTML = `
<style>
  .glow { position: fixed; inset: 0; pointer-events: none; opacity: 0; transition: opacity 180ms; }
  .cursor { position: fixed; left: 0; top: 0; width: 20px; height: 20px; pointer-events: none; z-index: 2147483646;
            opacity: 0; transition: transform 180ms cubic-bezier(0.2,0,0,1), opacity 180ms; }
</style>
<div class="glow"></div>
<svg class="cursor" viewBox="0 0 20 20"><path d="M2 2 L2 16 L6 12.5 L9 18 L11.5 16.8 L8.6 11.4 L14 11 Z" fill="#fff" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/></svg>`;
const cursor = root.querySelector<SVGElement>(".cursor")!;
const glow = root.querySelector<HTMLElement>(".glow")!;
document.documentElement.appendChild(host);

chrome.runtime.onMessage.addListener((msg: OverlayMessage, _sender, sendResponse) => {
  if (msg.type === "webop:cursor") {
    cursor.style.transform = `translate(${msg.x}px, ${msg.y}px)`;
    cursor.style.opacity = "1";
  } else if (msg.type === "webop:glow") {
    glow.style.boxShadow = msg.on ? `inset 0 0 40px 6px ${msg.color}` : "none";
    glow.style.opacity = msg.on ? "1" : "0";
  } else if (msg.type === "webop:overlay") {
    host.style.display = msg.hidden ? "none" : "";
    // Reply after the next frame so the hide has been painted before a screenshot is taken.
    requestAnimationFrame(() => requestAnimationFrame(() => sendResponse({ ok: true })));
    return true;
  }
  return false;
});
