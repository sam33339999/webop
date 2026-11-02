import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_ATTEMPTS = 1000;
/** Name length cap in UTF-8 bytes, `.gif` included (file systems limit names to 255 bytes; `-N` suffixes need room). */
export const GIF_NAME_MAX_BYTES = 200;

/** WEBOP_GIF_DIR (an advanced/testing override; an empty value counts as unset), else ~/Downloads/webop. */
export function gifDir(): string {
  return process.env.WEBOP_GIF_DIR || path.join(os.homedir(), "Downloads", "webop");
}

/** The longest prefix of `s` that fits in `max` UTF-8 bytes, never splitting a character. */
function fitBytes(s: string, max: number): string {
  let out = "";
  let bytes = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch, "utf8");
    if (bytes + n > max) break;
    out += ch;
    bytes += n;
  }
  return out;
}

/** Reduce an untrusted file name to a safe, flat `.gif` basename. */
export function safeGifName(name: string): string {
  let n = path.basename(String(name).replace(/\\/g, "/"));
  // eslint-disable-next-line no-control-regex
  n = n.replace(/[/\\:\u0000-\u001f\u007f]/g, "-").replace(/^\.+/, "");
  if (n === "") return "webop.gif";
  const stem = n.toLowerCase().endsWith(".gif") ? n.slice(0, -4) : n;
  const fitted = fitBytes(stem, GIF_NAME_MAX_BYTES - 4);
  return `${fitted === "" ? "webop" : fitted}.gif`;
}

/** Write `data` into `dir` under a sanitized, non-clobbering name; returns the absolute path. */
export function writeGif(dir: string, name: string, data: Buffer): string {
  fs.mkdirSync(dir, { recursive: true });
  const absDir = fs.realpathSync(dir);
  const safe = safeGifName(name);
  const stem = safe.slice(0, -4);
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const p = path.join(absDir, i === 0 ? safe : `${stem}-${i}.gif`);
    if (path.dirname(p) !== absDir) throw new Error("gif path escapes target directory");
    let fd: number;
    try {
      fd = fs.openSync(p, "wx", 0o644);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw e;
    }
    try {
      fs.writeFileSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }
    return p;
  }
  throw new Error("could not find a free GIF file name");
}
