// Phantom cursor and glow overlay. Lives in a closed-style shadow root so page CSS cannot touch it.
// Injected on demand (and again after reloads); the flag keeps a second injection into the same document inert.
// The guard is live only while this extension context is: after an extension reload the old context is orphaned (chrome.runtime.id is gone), so a fresh injection replaces its host.
type Guard = { alive: () => boolean; dispose?: () => void };
const guardHolder = window as unknown as { __wopOverlay?: Guard };
if (guardHolder.__wopOverlay?.alive()) {
  // already running in this document
} else {
guardHolder.__wopOverlay?.dispose?.();
type OverlayMessage =
  | { type: "webop:cursor"; x: number; y: number }
  | { type: "webop:overlay"; hidden: boolean }
  | { type: "webop:glow"; on: boolean; color: string }
  | { type: "webop:session_end" }
  | { type: "webop:overlay_state" };

const host = document.createElement("div");
host.style.cssText = "all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483646;";
const root = host.attachShadow({ mode: "closed" });
root.innerHTML = `
<style>
  .glow { position: fixed; inset: 0; pointer-events: none; opacity: 0; transition: opacity 180ms; }
  .stop { position: fixed; right: 16px; bottom: 16px; width: 88px; height: 36px; display: none; pointer-events: auto;
          z-index: 2147483647; border: 0; border-radius: 18px; background: #dc2626; color: #fff; font: 600 14px/36px system-ui, sans-serif;
          cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.35); padding: 0; }
  .cursor { position: fixed; left: 0; top: 0; width: 20px; height: 20px; pointer-events: none; z-index: 2147483646;
            opacity: 0; transition: transform 180ms cubic-bezier(0.2,0,0,1), opacity 180ms; }
</style>
<div class="glow"></div>
<button class="stop" type="button">停止</button>
<svg class="cursor" viewBox="0 0 20 20"><path d="M2 2 L2 16 L6 12.5 L9 18 L11.5 16.8 L8.6 11.4 L14 11 Z" fill="#fff" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/></svg>`;
const cursor = root.querySelector<SVGElement>(".cursor")!;
const glow = root.querySelector<HTMLElement>(".glow")!;
const stop = root.querySelector<HTMLButtonElement>(".stop")!;
// Only a real click counts; script-made events (isTrusted false) never stop anything.
stop.addEventListener("click", (e) => {
  if (e.isTrusted) chrome.runtime.sendMessage({ type: "webop:stop" }).catch(() => {});
});
document.documentElement.appendChild(host);
guardHolder.__wopOverlay = { alive: () => !!chrome.runtime?.id, dispose: () => host.remove() };

chrome.runtime.onMessage.addListener((msg: OverlayMessage, _sender, sendResponse) => {
  if (msg.type === "webop:cursor") {
    cursor.style.transform = `translate(${msg.x}px, ${msg.y}px)`;
    cursor.style.opacity = "1";
  } else if (msg.type === "webop:glow") {
    glow.style.boxShadow = msg.on ? `inset 0 0 40px 6px ${msg.color}` : "none";
    glow.style.opacity = msg.on ? "1" : "0";
    stop.style.display = msg.on ? "block" : "none";
  } else if (msg.type === "webop:session_end") {
    cursor.style.opacity = "0";
    glow.style.boxShadow = "none";
    glow.style.opacity = "0";
    stop.style.display = "none";
  } else if (msg.type === "webop:overlay") {
    host.style.display = msg.hidden ? "none" : "";
    // Reply right away: background tabs (what agents drive) never run requestAnimationFrame, so waiting for a frame would only time out.
    sendResponse({ ok: true });
  } else if (__DEV__ && msg.type === "webop:overlay_state") {
    sendResponse({ cursorOpacity: cursor.style.opacity, glowOpacity: glow.style.opacity, hidden: host.style.display === "none" });
  }
  return false;
});
}
