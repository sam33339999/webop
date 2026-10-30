import { getDomain, getHostname } from "tldts";

/** eTLD+1 of an http(s) URL; hostname for IPs and suffix-less hosts (e.g. localhost); null otherwise. */
export function siteOf(url: string): string | null {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return null;
  }
  if (protocol !== "http:" && protocol !== "https:") return null;
  const host = getHostname(url);
  if (!host) return null;
  return getDomain(url) ?? host;
}
