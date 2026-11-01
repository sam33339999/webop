import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { extensionIdFromKey } from "@webop/core/extension-id";
import { runHost } from "./host.ts";
import { install, uninstall } from "./install.ts";
import { runMcp } from "./mcp.ts";
import { MCP_USAGE, parseMcpArgs } from "./mcp-args.ts";

const [cmd, ...rest] = process.argv.slice(2);
const usage = "usage: webop native-host | webop mcp [--profile <id|label>] [--image-max-px <n>] [--image-max-tokens <n>] [--px-per-token <n>] | webop install [--browser-dir <dir>] | webop uninstall [--browser-dir <dir>]\n";
if (cmd === "native-host") {
  await runHost({ input: process.stdin, output: process.stdout });
  process.exit(0);
} else if (cmd === "mcp") {
  const parsed = parseMcpArgs(rest);
  if ("error" in parsed) {
    process.stderr.write(`webop mcp: ${parsed.error}\n${MCP_USAGE}`);
    process.exit(2);
  }
  await runMcp(parsed);
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
  const scriptPath = fileURLToPath(import.meta.url);
  const out = install({ browserDir, extensionId, webopCommand: [process.execPath, scriptPath] });
  const commandJson = [process.execPath, scriptPath, "mcp"].map((x) => JSON.stringify(x)).join(", ");
  const opencode = `{\n  "mcp": {\n    "webop": {\n      "type": "local",\n      "command": [${commandJson}],\n      "enabled": true\n    }\n  }\n}`;
  process.stdout.write(`extension id: ${extensionId}\nmanifest: ${out.manifestPath}\nwrapper: ${out.wrapperPath}\n\nAdd this to your opencode config:\n${opencode}\n`);
  process.exit(0);
} else if (cmd === "uninstall") {
  const i = rest.indexOf("--browser-dir");
  const browserDir = i >= 0 ? rest[i + 1] : undefined;
  if (i >= 0 && !browserDir) {
    process.stderr.write("usage: webop uninstall [--browser-dir <dir>]\n");
    process.exit(2);
  }
  const out = uninstall({ browserDir });
  process.stdout.write(`removed: ${out.manifestPath}\nremoved: ${out.wrapperPath}\n`);
  process.exit(0);
} else {
  process.stderr.write(usage);
  process.exit(2);
}
