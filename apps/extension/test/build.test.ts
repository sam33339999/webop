import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ext = join(dirname(fileURLToPath(import.meta.url)), "..");

async function buildTo(args: string[]): Promise<string> {
  const out = await mkdtemp(join(tmpdir(), "webop-build-"));
  execFileSync(process.execPath, [join(ext, "build.ts"), ...args, "--outdir", out], { stdio: "pipe" });
  return out;
}

test("prod build has no test hook", async () => {
  const out = await buildTo([]);
  try {
    for (const f of ["sw.js", "overlay.js", "ax.js", "options.js"]) {
      assert.ok(!(await readFile(join(out, f), "utf8")).includes("__webop"), `${f} contains __webop`);
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("dev build exposes the test hook (guards the check above)", async () => {
  const out = await buildTo(["--dev"]);
  try {
    assert.ok((await readFile(join(out, "sw.js"), "utf8")).includes("__webop"));
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
