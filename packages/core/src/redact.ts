export const REDACTED = "REDACTED";

const SENSITIVE_PARTS = new Set([
  "token", "code", "auth", "key", "secret", "sig", "signature", "hash", "hmac", "otp", "pass",
  "password", "passwd", "pwd", "session", "sid", "jwt", "bearer", "nonce", "assertion",
  "credential", "credentials", "ticket", "totp", "pin", "cvv", "cvc",
]);
const SENSITIVE_WHOLE = new Set(["apikey", "accesstoken", "idtoken", "sessionid", "authorization"]);

function isSensitiveName(rawName: string): boolean {
  let name = rawName;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    // keep raw name
  }
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((p) => p.toLowerCase());
  if (parts.some((p) => SENSITIVE_PARTS.has(p))) return true;
  return SENSITIVE_WHOLE.has(parts.join(""));
}

/** Redact values of sensitive params in a raw "a=b&c=d" string without re-encoding anything. */
function redactParams(raw: string): string {
  return raw
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 0) return pair;
      return isSensitiveName(pair.slice(0, eq)) ? `${pair.slice(0, eq)}=${REDACTED}` : pair;
    })
    .join("&");
}

/** Mask credentials in a URL (userinfo, sensitive query/fragment values). Unparseable input is returned as-is. */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  let rest = url;
  let fragment = "";
  const hashAt = rest.indexOf("#");
  if (hashAt >= 0) {
    fragment = "#" + redactParams(rest.slice(hashAt + 1));
    rest = rest.slice(0, hashAt);
  }
  let query = "";
  const qAt = rest.indexOf("?");
  if (qAt >= 0) {
    query = "?" + redactParams(rest.slice(qAt + 1));
    rest = rest.slice(0, qAt);
  }
  if (parsed.username || parsed.password) {
    rest = rest.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, `$1${REDACTED}@`);
  }
  return rest + query + fragment;
}

const URL_IN_TEXT = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi;
const OPENERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/** Redact every URL found in free text; trailing sentence punctuation / unbalanced closers are kept outside the URL. */
export function redactUrlsInText(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => {
    let url = match;
    let tail = "";
    for (;;) {
      const last = url[url.length - 1];
      if (last === undefined) break;
      const opener = OPENERS[last];
      const strip =
        ".,;:!?".includes(last) ||
        (opener !== undefined && url.split(last).length - 1 > url.split(opener).length - 1);
      if (!strip) break;
      tail = last + tail;
      url = url.slice(0, -1);
    }
    return redactUrl(url) + tail;
  });
}
