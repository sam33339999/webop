import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { safeGifName, writeGif, gifDir, GIF_NAME_MAX_BYTES } from "../src/gif-file.ts";

test("safeGifName sanitizes", () => {
  assert.equal(safeGifName("../../etc/passwd"), "passwd.gif");
  assert.equal(safeGifName("a:b"), "a-b.gif");
  assert.equal(safeGifName(".x.gif"), "x.gif");
  assert.equal(safeGifName(""), "webop.gif");
  assert.equal(safeGifName("a\u0001b.gif"), "a-b.gif");
  assert.equal(safeGifName("x".repeat(300)), "x".repeat(196) + ".gif");
  assert.equal(safeGifName(".gif"), "gif.gif");
});

test("safeGifName caps by UTF-8 bytes without splitting characters", () => {
  for (const ch of ["錄", "😀", "é"]) {
    const n = safeGifName(ch.repeat(300) + ".gif");
    assert.ok(Buffer.byteLength(n, "utf8") <= GIF_NAME_MAX_BYTES, `${ch}: ${Buffer.byteLength(n, "utf8")} bytes`);
    assert.ok(n.endsWith(".gif"));
    assert.ok(!n.includes("\ufffd"));
    assert.equal(n.slice(0, -4), ch.repeat(Array.from(n.slice(0, -4)).length), `${ch}: whole characters only`);
  }
  // 196 bytes of stem: 65 three-byte characters (195 bytes), not 66.
  assert.equal(Array.from(safeGifName("錄".repeat(300)).slice(0, -4)).length, 65);
});

test("gifDir honors WEBOP_GIF_DIR", () => {
  const old = process.env.WEBOP_GIF_DIR;
  process.env.WEBOP_GIF_DIR = "/x/y";
  assert.equal(gifDir(), "/x/y");
  if (old === undefined) delete process.env.WEBOP_GIF_DIR; else process.env.WEBOP_GIF_DIR = old;
  assert.equal(gifDir().endsWith(path.join("Downloads", "webop")), true);
  process.env.WEBOP_GIF_DIR = "";
  assert.equal(gifDir().endsWith(path.join("Downloads", "webop")), true, "empty counts as unset");
  if (old === undefined) delete process.env.WEBOP_GIF_DIR; else process.env.WEBOP_GIF_DIR = old;
});

test("writeGif avoids collisions", () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gif-")), "sub");
  const a = writeGif(dir, "r.gif", Buffer.from("one"));
  const b = writeGif(dir, "r.gif", Buffer.from("two"));
  assert.equal(path.basename(a), "r.gif");
  assert.equal(path.basename(b), "r-1.gif");
  assert.equal(fs.readFileSync(a, "utf8"), "one");
  assert.equal(fs.readFileSync(b, "utf8"), "two");
  assert.equal(fs.statSync(a).mode & 0o111, 0);
});
