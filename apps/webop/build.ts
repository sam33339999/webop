import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionIdFromKey } from "@webop/core/extension-id";

const root = dirname(fileURLToPath(import.meta.url));
// The built webop (and the SEA made from it) has no extension manifest next to it, so the id is baked in.
const manifest = JSON.parse(readFileSync(join(root, "../extension/manifest.json"), "utf8"));
const extensionId = await extensionIdFromKey(manifest.key);
await build({
  entryPoints: [join(root, "src/cli.ts")],
  outfile: join(root, "dist/webop.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  banner: { js: "#!/usr/bin/env node" },
  define: { __WEBOP_EXTENSION_ID__: JSON.stringify(extensionId) },
  logLevel: "warning",
});
