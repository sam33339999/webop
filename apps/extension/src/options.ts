import { siteOf } from "@webop/core/domain";

const PROFILE_KEY = "webop.profile_id";
const GRANTS_KEY = "webop.grants";
const DENY_KEY = "webop.deny";
const JS_KEY = "webop.js_enabled";
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** "example.com", "https://www.Example.com/x" or "localhost" -> the site key the deny list stores. */
function normalize(line: string): string | null {
  const site = siteOf(line.includes("://") ? line : `https://${line}`);
  return site ? site.toLowerCase() : null;
}

async function readGrants(): Promise<Record<string, string[]>> {
  const raw = (await chrome.storage.local.get(GRANTS_KEY))[GRANTS_KEY];
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, string[]>) : {};
}

async function renderGrants(): Promise<void> {
  const grants = await readGrants();
  const body = $("grants");
  body.replaceChildren();
  const sites = Object.keys(grants).sort();
  $("no-grants").hidden = sites.length > 0;
  for (const site of sites) {
    const row = document.createElement("tr");
    row.dataset.site = site;
    const name = document.createElement("td");
    name.textContent = site;
    const levels = document.createElement("td");
    levels.textContent = grants[site]!.join(", ");
    const action = document.createElement("td");
    const button = document.createElement("button");
    button.textContent = "Revoke";
    button.className = "revoke";
    button.addEventListener("click", async () => {
      const current = await readGrants();
      delete current[site];
      await chrome.storage.local.set({ [GRANTS_KEY]: current });
      await renderGrants();
    });
    action.append(button);
    row.append(name, levels, action);
    body.append(row);
  }
}

async function init(): Promise<void> {
  // Opening this page is the recovery path after `webop install` ran later than the extension was loaded.
  chrome.runtime.sendMessage({ type: "webop:wake" }).catch(() => {});
  $("ext-id").textContent = chrome.runtime.id;
  const stored = await chrome.storage.local.get([PROFILE_KEY, DENY_KEY, JS_KEY]);
  $("profile-id").textContent = typeof stored[PROFILE_KEY] === "string" ? stored[PROFILE_KEY] : "(not registered yet)";
  await renderGrants();

  const area = $<HTMLTextAreaElement>("deny");
  area.value = Array.isArray(stored[DENY_KEY]) ? stored[DENY_KEY].join("\n") : "";
  $("save-deny").addEventListener("click", async () => {
    const lines = area.value.split("\n").map((l) => l.trim()).filter(Boolean);
    const normalized = lines.map(normalize);
    const sites = [...new Set(normalized.filter((s): s is string => s !== null))];
    await chrome.storage.local.set({ [DENY_KEY]: sites });
    area.value = sites.join("\n");
    const rejected = normalized.filter((s) => s === null).length;
    $("deny-status").textContent = rejected > 0 ? `Saved; ignored ${rejected} invalid line(s).` : "Saved.";
  });

  const js = $<HTMLInputElement>("js-enabled");
  js.checked = stored[JS_KEY] === true;
  js.addEventListener("change", () => chrome.storage.local.set({ [JS_KEY]: js.checked }));
}

void init();
