import { siteOf } from "@webop/core/domain";

const PROFILE_KEY = "webop.profile_id";

const ALLOW_KEY = "webop.allow";
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** "example.com", "https://www.example.com/x" or "localhost" -> the site key the allowlist stores. */
function normalize(line: string): string | null {
  const site = siteOf(line.includes("://") ? line : `https://${line}`);
  return site ? site.toLowerCase() : null;
}

async function init(): Promise<void> {
  // Opening this page is the recovery path after `webop install` ran later than the extension was loaded.
  chrome.runtime.sendMessage({ type: "webop:wake" }).catch(() => {});
  $("ext-id").textContent = chrome.runtime.id;
  const profile = (await chrome.storage.local.get(PROFILE_KEY))[PROFILE_KEY];
  $("profile-id").textContent = typeof profile === "string" ? profile : "(not registered yet)";
  const area = $<HTMLTextAreaElement>("allow");
  const stored = (await chrome.storage.local.get(ALLOW_KEY))[ALLOW_KEY];
  area.value = Array.isArray(stored) ? stored.join("\n") : "";
  $("save").addEventListener("click", async () => {
    const lines = area.value.split("\n").map((l) => l.trim()).filter(Boolean);
    const sites = [...new Set(lines.map(normalize).filter((s): s is string => s !== null))];
    const rejected = lines.length - lines.map(normalize).filter((s) => s !== null).length;
    await chrome.storage.local.set({ [ALLOW_KEY]: sites });
    area.value = sites.join("\n");
    $("status").textContent = rejected > 0 ? `Saved; ignored ${rejected} invalid line(s).` : "Saved.";
  });
}

void init();
