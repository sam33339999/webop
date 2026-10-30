import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { extensionIdFromKey } from "@webop/core/extension-id";
import { runHost } from "./host.ts";
import { install } from "./install.ts";
import { runMcp } from "./mcp.ts";

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "native-host") {
  await runHost({ input: process.stdin, output: process.stdout });
  process.exit(0);
} else if (cmd === "mcp") {
  await runMcp();
  process.exit(0);
} else if (cmd === "install") {
  const i = rest.indexOf("--browser-dir");
  const browserDir = i >= 0 ? rest[i + 1] : undefined;
  if (i >= 0 && !browserDir) {
    process.stderr.write("usage: webop install [--browser-dir <dir>]\n");
    process.exit(2);
  }
  // Development install: this script is dist/webop.mjs, the manifest sits in the sibling extension app.
  const manifest = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../extension/manifest.json", import.meta.url)), "utf8"));
  const extensionId = await extensionIdFromKey(manifest.key);
  const out = install({ browserDir, extensionId, webopCommand: [process.execPath, fileURLToPath(import.meta.url)] });
  process.stdout.write(`extension id: ${extensionId}\nmanifest: ${out.manifestPath}\nwrapper: ${out.wrapperPath}\n`);
  process.exit(0);
} else {
  process.stderr.write("usage: webop native-host | webop mcp | webop install [--browser-dir <dir>]\n");
  process.exit(2);
}
