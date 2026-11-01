import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseMcpArgs } from "../src/mcp-args.ts";

test("no flags: no profile, default budget left to the extension", () => {
  assert.deepEqual(parseMcpArgs([]), { profile: undefined, budget: undefined });
});

test("budget flags fill in the rest from the defaults", () => {
  assert.deepEqual(parseMcpArgs(["--image-max-px", "1024", "--profile", "Work"]), {
    profile: "Work",
    budget: { pxPerToken: 28, maxTargetPx: 1024, maxTargetTokens: 1568 },
  });
  const r = parseMcpArgs(["--px-per-token", "32", "--image-max-tokens", "800"]);
  assert.ok(!("error" in r));
  assert.deepEqual(r.budget, {
    pxPerToken: 32, maxTargetPx: 1568, maxTargetTokens: 800,
  });
});

test("non-positive, non-integer, missing and unknown values are errors", () => {
  for (const args of [["--image-max-px", "0"], ["--image-max-px", "-5"], ["--image-max-px", "1.5"], ["--image-max-px"], ["--px-per-token", "abc"], ["--profile"], ["--bogus"]]) {
    assert.ok("error" in parseMcpArgs(args), args.join(" "));
  }
});

test("t_budget_flag_invalid_exits_2: `webop mcp` with a bad flag reports on stderr and exits 2", () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const r = spawnSync(process.execPath, [cli, "mcp", "--image-max-px", "0"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--image-max-px needs a positive integer/);
});
