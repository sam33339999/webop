import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rootDir } from "./paths.ts";

export const HOST_NAME = "com.webop.native_host";

function hostDir(browserDir?: string): string {
  const base = browserDir ?? path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
  return path.join(base, "NativeMessagingHosts");
}
export const manifestFile = (browserDir?: string) => path.join(hostDir(browserDir), `${HOST_NAME}.json`);
export const wrapperFile = (root?: string) => path.join(rootDir(root), "bin", "webop-native-host");
const shQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * The command a wrapper written by `install` runs (`exec '<a>' '<b>' native-host` → ["<a>", "<b>"]); undefined when the
 * wrapper has no exec line in that format. The inverse of the quoting `install` uses.
 */
export function parseWrapperExec(wrapper: string): string[] | undefined {
  const line = wrapper.split("\n").find((l) => l.startsWith("exec "));
  const m = line && /^exec((?:\s+'(?:[^']|'\\'')*')+)\s+native-host\s*$/.exec(line);
  if (!m) return undefined;
  return [...m[1]!.matchAll(/'((?:[^']|'\\'')*)'/g)].map((x) => x[1]!.replaceAll("'\\''", "'"));
}

export function install(o: { browserDir?: string; webopCommand: string[]; extensionId: string; root?: string }): { manifestPath: string; wrapperPath: string } {
  const wrapperPath = wrapperFile(o.root);
  const manifestPath = manifestFile(o.browserDir);
  // Only an explicit root is pinned into the wrapper; the default root is resolved at run time.
  const exportLine = o.root === undefined ? "" : `export WEBOP_ROOT=${shQuote(o.root)}\n`;
  fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
  fs.writeFileSync(wrapperPath, `#!/bin/sh\n${exportLine}exec ${o.webopCommand.map(shQuote).join(" ")} native-host\n`);
  fs.chmodSync(wrapperPath, 0o755);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({
    name: HOST_NAME,
    description: "webop native messaging host",
    path: wrapperPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${o.extensionId}/`],
  }, null, 2) + "\n");
  return { manifestPath, wrapperPath };
}

export function uninstall(o: { browserDir?: string; root?: string }): { manifestPath: string; wrapperPath: string } {
  const manifestPath = manifestFile(o.browserDir);
  const wrapperPath = wrapperFile(o.root);
  fs.rmSync(manifestPath, { force: true });
  fs.rmSync(wrapperPath, { force: true });
  return { manifestPath, wrapperPath };
}
