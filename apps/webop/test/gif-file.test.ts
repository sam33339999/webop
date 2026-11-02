import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { safeGifName, writeGif, gifDir } from "../src/gif-file.ts";

test("safeGifName sanitizes", () => {
  assert.equal(safeGifName("../../etc/passwd"), "passwd.gif");
  assert.equal(safeGifName("a:b"), "a-b.gif");
  assert.equal(safeGifName(".x.gif"), "x.gif");
  assert.equal(safeGifName(""), "webop.gif");
  assert.equal(safeGifName("a\u0001b.gif"), "a-b.gif");
  assert.equal(safeGifName("x".repeat(300)).length <= 104, true);
});

test("gifDir honors WEBOP_GIF_DIR", () => {
  const old = process.env.WEBOP_GIF_DIR;
  process.env.WEBOP_GIF_DIR = "/x/y";
  assert.equal(gifDir(), "/x/y");
  if (old === undefined) delete process.env.WEBOP_GIF_DIR; else process.env.WEBOP_GIF_DIR = old;
  assert.equal(gifDir().endsWith(path.join("Downloads", "webop")), true);
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
