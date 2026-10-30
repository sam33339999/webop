import { siteOf } from "@webop/core/domain";
import { CdpError } from "./cdp.ts";

export const ALLOW_KEY = "webop.allow";

/** Throws permission_denied unless the URL's site is in the user's allowlist (`webop.allow` in chrome.storage.local). */
export async function checkSite(url: string): Promise<void> {
  const site = siteOf(url);
  const stored = (await chrome.storage.local.get(ALLOW_KEY))[ALLOW_KEY];
  const allow = Array.isArray(stored) ? stored.filter((s): s is string => typeof s === "string").map((s) => s.trim().toLowerCase()) : [];
  if (site !== null && allow.includes(site.toLowerCase())) return;
  const what = site === null ? "this page (not an http(s) site)" : `site "${site}"`;
  throw new CdpError("permission_denied", `Access to ${what} is not allowed; add it in webop options to let the agent use it.`);
}

export async function isSiteAllowed(url: string): Promise<boolean> {
  try {
    await checkSite(url);
    return true;
  } catch {
    return false;
  }
}
