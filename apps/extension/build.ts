import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
const dev = process.argv.includes("--dev");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const common = { bundle: true, define: { __DEV__: String(dev) }, target: "chrome116", logLevel: "warning" as const };

await build({ ...common, entryPoints: [join(root, "src/sw/index.ts")], outfile: join(dist, "sw.js"), format: "esm" });
for (const name of ["overlay", "ax", "options"]) {
  await build({ ...common, entryPoints: [join(root, `src/${name}.ts`)], outfile: join(dist, `${name}.js`), format: "iife" });
}
await cp(join(root, "manifest.json"), join(dist, "manifest.json"));
await cp(join(root, "src/options.html"), join(dist, "options.html"));
