import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/version.ts";

const json = (rel: string) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));

test("t_versions_match: the CLI, extension manifest and packages carry one version", () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(json("../../extension/manifest.json").version, VERSION, "bump apps/extension/manifest.json too");
  assert.equal(json("../../extension/package.json").version, VERSION);
  assert.equal(json("../../../packages/core/package.json").version, VERSION);
});

test("t_changelog_has_version: CHANGELOG.md has an entry for the current version", () => {
  const log = readFileSync(fileURLToPath(new URL("../../../CHANGELOG.md", import.meta.url)), "utf8");
  assert.ok(log.includes(`## ${VERSION}`), `CHANGELOG.md has no "## ${VERSION}" section`);
});

test("webop --version prints the version", () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const r = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), `webop ${VERSION}`);
});

test("t_sea_binary_version: the single executable prints the version", (t) => {
  const sea = fileURLToPath(new URL("../dist/webop", import.meta.url));
  try {
    readFileSync(sea);
  } catch {
    t.skip("run `pnpm --filter @webop/cli build:sea` first");
    return;
  }
  const r = spawnSync(sea, ["--version"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `webop ${VERSION}`);
});
