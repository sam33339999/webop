import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { doctor, formatChecks, type Check } from "../src/doctor.ts";
import { install } from "../src/install.ts";
import { readLines, writeLine } from "../src/ndjson.ts";
import { descriptorPath, runDir, socketPath } from "../src/paths.ts";
import { VERSION } from "../src/version.ts";

const EXT = "abcdefghijklmnopabcdefghijklmnop";
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function env() {
  // Short root: unix socket paths are capped near 104 bytes on macOS.
  const root = fs.mkdtempSync("/tmp/wd-");
  const browserDir = tmp("wdb-");
  fs.mkdirSync(runDir(root), { recursive: true });
  return { root, browserDir };
}

function descriptor(root: string, id: string, label: string, pid = process.pid) {
  fs.writeFileSync(descriptorPath(id, root), JSON.stringify({ profile_id: id, profile_label: label, pid, started_at: new Date().toISOString() }));
}

async function pongHost(root: string, id: string, label: string, extension_version = VERSION) {
  descriptor(root, id, label);
  const srv = net.createServer((s) => readLines(s, (m: any) => {
    if (m.type === "ping") {
      writeLine(s, { type: "pong", profile_id: id, profile_label: label, extension_version, webop_version: VERSION, sessions: 2 });
      s.end();
    }
  }));
  await new Promise<void>((r) => srv.listen(socketPath(id, root), r));
  return { close: () => srv.close() };
}

const levels = (cs: Check[]) => cs.map((c) => c.level);
const find = (cs: Check[], re: RegExp) => cs.find((c) => re.test(c.title) || re.test(c.detail ?? ""));

test("t_doctor_all_ok: installed host and an online profile give no warn or FAIL", async () => {
  const { root, browserDir } = env();
  install({ browserDir, root, extensionId: EXT, webopCommand: [process.execPath, "/x/webop.mjs"] });
  const h = await pongHost(root, "p1", "Work");
  const cs = await doctor({ root, browserDirs: [browserDir], extensionId: EXT });
  assert.deepEqual(levels(cs).filter((l) => l !== "ok"), [], formatChecks(cs));
  assert.ok(find(cs, /Work \(p1\)/), formatChecks(cs));
  h.close();
});

test("t_doctor_no_manifest: no host manifest in the first browser dir is a FAIL", async () => {
  const { root, browserDir } = env();
  const cs = await doctor({ root, browserDirs: [browserDir], extensionId: EXT });
  assert.equal(find(cs, /host manifest/)?.level, "FAIL", formatChecks(cs));
});

test("t_doctor_second_dir_missing_is_ok: a second browser dir without a manifest is fine (Brave reads Chrome's)", async () => {
  const { root, browserDir } = env();
  install({ browserDir, root, extensionId: EXT, webopCommand: [process.execPath, "/x/webop.mjs"] });
  const other = tmp("wdb2-");
  const cs = await doctor({ root, browserDirs: [browserDir, other], extensionId: EXT });
  const manifests = cs.filter((c) => /host manifest/.test(c.title));
  assert.deepEqual(manifests.map((c) => c.level), ["ok", "ok"], formatChecks(cs));
  assert.match(manifests[1]!.detail ?? "", /not present/);
});

test("t_doctor_wrong_origin: a manifest for another extension id is a FAIL", async () => {
  const { root, browserDir } = env();
  install({ browserDir, root, extensionId: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", webopCommand: [process.execPath, "/x/webop.mjs"] });
  const cs = await doctor({ root, browserDirs: [browserDir], extensionId: EXT });
  assert.equal(find(cs, /host manifest/)?.level, "FAIL", formatChecks(cs));
});

test("t_doctor_wrapper_target_missing: a wrapper that execs a missing file is a FAIL naming it", async () => {
  const { root, browserDir } = env();
  install({ browserDir, root, extensionId: EXT, webopCommand: ["/nonexistent/webop"] });
  const cs = await doctor({ root, browserDirs: [browserDir], extensionId: EXT });
  const w = find(cs, /^wrapper/);
  assert.equal(w?.level, "FAIL", formatChecks(cs));
  assert.match(w!.detail ?? "", /\/nonexistent\/webop/);
  assert.match(w!.detail ?? "", /webop install/);
});

test("t_doctor_version_mismatch: extension and webop versions differ → warn with both", async () => {
  const { root, browserDir } = env();
  install({ browserDir, root, extensionId: EXT, webopCommand: [process.execPath, "/x/webop.mjs"] });
  const h = await pongHost(root, "p1", "Work", "0.0.9");
  const cs = await doctor({ root, browserDirs: [browserDir], extensionId: EXT });
  const v = cs.find((c) => c.level === "warn" && /0\.0\.9/.test(c.detail ?? ""));
  assert.ok(v, formatChecks(cs));
  assert.ok(v!.detail!.includes(VERSION));
  h.close();
});

test("t_doctor_dead_socket: a live descriptor whose socket accepts nothing is a FAIL, quickly", async () => {
  const { root, browserDir } = env();
  install({ browserDir, root, extensionId: EXT, webopCommand: [process.execPath, "/x/webop.mjs"] });
  descriptor(root, "p1", "Work");
  fs.writeFileSync(socketPath("p1", root), "not a socket");
  const started = Date.now();
  const cs = await doctor({ root, browserDirs: [browserDir], extensionId: EXT, pingTimeoutMs: 300 });
  assert.ok(Date.now() - started < 1300, `took ${Date.now() - started} ms`);
  const p = find(cs, /Work \(p1\)/);
  assert.equal(p?.level, "FAIL", formatChecks(cs));
  assert.match(p!.title + (p!.detail ?? ""), /not accepting connections/);
});

test("t_doctor_silent_socket: a socket that never answers is a FAIL after the timeout", async () => {
  const { root, browserDir } = env();
  install({ browserDir, root, extensionId: EXT, webopCommand: [process.execPath, "/x/webop.mjs"] });
  descriptor(root, "p1", "Work");
  const srv = net.createServer(() => {});
  await new Promise<void>((r) => srv.listen(socketPath("p1", root), r));
  const cs = await doctor({ root, browserDirs: [browserDir], extensionId: EXT, pingTimeoutMs: 300 });
  const p = find(cs, /Work \(p1\)/);
  assert.equal(p?.level, "FAIL", formatChecks(cs));
  assert.match(p!.title, /did not answer/);
  srv.close();
});

test("t_doctor_old_host: a host that closes on ping (pre-0.6.0) is reported as probably old", async () => {
  const { root, browserDir } = env();
  install({ browserDir, root, extensionId: EXT, webopCommand: [process.execPath, "/x/webop.mjs"] });
  descriptor(root, "p1", "Work");
  const srv = net.createServer((s) => readLines(s, () => s.destroy()));
  await new Promise<void>((r) => srv.listen(socketPath("p1", root), r));
  const cs = await doctor({ root, browserDirs: [browserDir], extensionId: EXT, pingTimeoutMs: 1000 });
  const p = find(cs, /Work \(p1\)/);
  assert.equal(p?.level, "FAIL", formatChecks(cs));
  assert.match(p!.detail ?? "", /predates ping support/);
  srv.close();
});

test("t_doctor_stale_descriptor: a dead pid's descriptor is a warn naming the file; no profile online warns", async () => {
  const { root, browserDir } = env();
  install({ browserDir, root, extensionId: EXT, webopCommand: [process.execPath, "/x/webop.mjs"] });
  const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
  descriptor(root, "gone", "Old", dead);
  const cs = await doctor({ root, browserDirs: [browserDir], extensionId: EXT });
  const stale = cs.find((c) => c.level === "warn" && /gone\.json/.test(c.detail ?? ""));
  assert.ok(stale, formatChecks(cs));
  assert.ok(cs.some((c) => c.level === "warn" && /no browser profile online/i.test(c.title)), formatChecks(cs));
});

test("t_doctor_exit_code: `webop doctor` exits 1 on FAIL and prints the version first", () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const r = spawnSync(process.execPath, [cli, "doctor", "--browser-dir", tmp("wdb-")], { encoding: "utf8", env: { ...process.env, WEBOP_ROOT: tmp("wdr-") } });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(r.stdout.split("\n")[0], `webop ${VERSION}`);
  assert.match(r.stdout, /^FAIL /m);
});
