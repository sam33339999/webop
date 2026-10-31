import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { extensionIdFromKey } from "../src/extension-id.ts";

test("matches reference derivation: sha256 prefix with 0-f mapped to a-p", async () => {
  const key = Buffer.from("webop-test-key").toString("base64");
  const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  const expected = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
  assert.equal(await extensionIdFromKey(key), expected);
});

test("is 32 chars in a-p", async () => {
  assert.match(await extensionIdFromKey("AAAA"), /^[a-p]{32}$/);
});
