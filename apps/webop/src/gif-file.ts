import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_ATTEMPTS = 1000;

export function gifDir(): string {
  return process.env.WEBOP_GIF_DIR ?? path.join(os.homedir(), "Downloads", "webop");
}

/** Reduce an untrusted file name to a safe, flat `.gif` basename. */
export function safeGifName(name: string): string {
  let n = path.basename(String(name).replace(/\\/g, "/"));
  // eslint-disable-next-line no-control-regex
  n = n.replace(/[/\\:\u0000-\u001f\u007f]/g, "-").replace(/^\.+/, "").slice(0, 100);
  if (n === "") return "webop.gif";
  if (!n.toLowerCase().endsWith(".gif")) n += ".gif";
  return n;
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
