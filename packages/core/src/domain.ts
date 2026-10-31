import { getDomain } from "tldts";

/**
 * Site key of an http(s) URL: the registrable domain, where private suffixes (github.io, vercel.app, ...)
 * count as public suffixes so each app is its own site. IPs and suffix-less hosts (localhost) map to the
 * hostname; anything not http(s) is null. The host is normalised by WHATWG URL first, as Chrome does.
 */
export function siteOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname;
  if (!host) return null;
  return getDomain(host, { allowPrivateDomains: true }) ?? host;
}
