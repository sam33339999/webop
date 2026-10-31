import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { install, uninstall } from "../src/install.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wi-"));

test("writes host manifest with fixed name, stdio, allowed_origins and executable wrapper", () => {
  const browserDir = tmp();
  const root = tmp();
  const { manifestPath, wrapperPath } = install({
    browserDir,
    root,
    extensionId: "abcdefghijklmnopabcdefghijklmnop",
    webopCommand: ["/usr/bin/node", "/opt/my dir/webop.mjs"],
  });
  assert.equal(manifestPath, path.join(browserDir, "NativeMessagingHosts", "com.webop.native_host.json"));
  assert.equal(wrapperPath, path.join(root, "bin", "webop-native-host"));
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(m.name, "com.webop.native_host");
  assert.equal(m.type, "stdio");
  assert.equal(m.path, wrapperPath);
  assert.deepEqual(m.allowed_origins, ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"]);
  assert.equal(typeof m.description, "string");
  assert.equal(fs.statSync(wrapperPath).mode & 0o777, 0o755);
  const body = fs.readFileSync(wrapperPath, "utf8");
  assert.ok(body.startsWith("#!/bin/sh\n"));
  assert.ok(body.includes(`export WEBOP_ROOT='${root}'`));
  assert.ok(body.trimEnd().endsWith("exec '/usr/bin/node' '/opt/my dir/webop.mjs' native-host"));
});

test("uninstall removes both", () => {
  const browserDir = tmp();
  const root = tmp();
  const { manifestPath, wrapperPath } = install({ browserDir, root, extensionId: "x", webopCommand: ["node", "w.mjs"] });
  uninstall({ browserDir, root });
  assert.equal(fs.existsSync(manifestPath), false);
  assert.equal(fs.existsSync(wrapperPath), false);
});

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const runCli = (args: string[], root: string) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, WEBOP_ROOT: root } });

test("t_uninstall_removes_files: cli uninstall removes files and prints paths", () => {
  const browserDir = tmp();
  const root = tmp();
  const { manifestPath, wrapperPath } = install({ browserDir, root, extensionId: "x", webopCommand: ["node", "w.mjs"] });
  const r = runCli(["uninstall", "--browser-dir", browserDir], root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(manifestPath), false);
  assert.equal(fs.existsSync(wrapperPath), false);
  assert.ok(r.stdout.includes(manifestPath));
  assert.ok(r.stdout.includes(wrapperPath));
});

test("install prints pasteable opencode config with absolute node and script paths", () => {
  const browserDir = tmp();
  const root = tmp();
  const r = runCli(["install", "--browser-dir", browserDir], root);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('"command": ["/'), r.stdout);
  const line = r.stdout.split("\n").find((l) => l.includes('"command"'))!;
  const cmd = JSON.parse(`{${line.trim().replace(/,$/, "")}}`).command as string[];
  assert.equal(cmd[0], process.execPath);
  assert.ok(path.isAbsolute(cmd[1]));
  assert.equal(cmd[2], "mcp");
});
