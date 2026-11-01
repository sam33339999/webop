// Packs dist/webop.mjs into the single executable dist/webop (Node SEA, ESM entry) and signs it ad hoc for macOS.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `node --build-sea` exists from Node 25.5; an older node (e.g. a shell still on Node 24) fails with "bad option".
const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
if (major < 25 || (major === 25 && minor < 5)) {
  process.stderr.write(`build:sea needs Node 26 (this is Node ${process.versions.node}). Run \`fnm use 26\` and try again.\n`);
  process.exit(1);
}

const root = dirname(fileURLToPath(import.meta.url));
const config = join(root, "dist", "sea-config.json");
writeFileSync(config, JSON.stringify({
  main: join(root, "dist", "webop.mjs"),
  mainFormat: "module",
  output: join(root, "dist", "webop"),
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
}, null, 2));

function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) {
    process.stderr.write(`${cmd} ${args.join(" ")} failed (${r.status ?? r.signal}):\n${r.stderr}${r.stdout}`);
    process.exit(1);
  }
}

run(process.execPath, ["--build-sea", config]);
if (process.platform === "darwin") run("codesign", ["--sign", "-", "--force", join(root, "dist", "webop")]);
process.stdout.write(`built ${join(root, "dist", "webop")}\n`);
