const id = new URLSearchParams(location.search).get("id");
const $ = <T extends HTMLElement>(el: string) => document.getElementById(el) as T;

async function init(): Promise<void> {
  const view = await chrome.runtime.sendMessage({ type: "webop:prompt_get", id });
  if (!view) { window.close(); return; }
  $("client").textContent = view.client_name;
  $("site").textContent = view.site;
  $("level").textContent = view.level;
  if (view.image) {
    const img = $<HTMLImageElement>("img");
    img.onload = () => {
      if (!view.marker) return;
      const m = $("marker");
      m.style.left = `${(view.marker.x / img.naturalWidth) * 100}%`;
      m.style.top = `${(view.marker.y / img.naturalHeight) * 100}%`;
      m.hidden = false;
    };
    img.src = view.image;
    $("shot").style.display = "block";
  }
  for (const answer of ["once", "always", "deny"] as const) {
    $(answer).addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "webop:prompt_answer", id, answer });
      window.close();
    });
  }
}
void init();
