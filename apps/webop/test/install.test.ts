import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
