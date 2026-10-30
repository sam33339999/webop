import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [join(root, "src/cli.ts")],
  outfile: join(root, "dist/webop.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "warning",
});
