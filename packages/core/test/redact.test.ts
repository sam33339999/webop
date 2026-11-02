import { test } from "node:test";
import assert from "node:assert/strict";
import { redactUrl, redactUrlsInText } from "../src/redact.ts";

test("redactUrl: credential-like query values", () => {
  assert.equal(redactUrl("https://a.com/x?token=abc&q=1"), "https://a.com/x?token=REDACTED&q=1");
  assert.equal(redactUrl("https://a.com/x?access_token=abc"), "https://a.com/x?access_token=REDACTED");
  assert.equal(redactUrl("https://a.com/x?apiKey=k"), "https://a.com/x?apiKey=REDACTED");
  assert.equal(redactUrl("https://a.com/cb?code=xyz&state=s"), "https://a.com/cb?code=REDACTED&state=s");
  assert.equal(redactUrl("https://a.com/x?X-Amz-Signature=s"), "https://a.com/x?X-Amz-Signature=REDACTED");
});
test("redactUrl: userinfo and fragment params", () => {
  assert.equal(redactUrl("https://u:p@a.com/"), "https://REDACTED@a.com/");
  assert.equal(redactUrl("https://a.com/#access_token=t&x=1"), "https://a.com/#access_token=REDACTED&x=1");
});
test("redactUrl: harmless names untouched, unparseable input unchanged", () => {
  assert.equal(redactUrl("https://a.com/s?q=keyword&page=2"), "https://a.com/s?q=keyword&page=2");
  assert.equal(redactUrl("https://a.com/s?keyword=x"), "https://a.com/s?keyword=x");
  assert.equal(redactUrl("not a url"), "not a url");
});
test("redactUrl: over-redaction accepted for *_code", () => {
  assert.equal(redactUrl("https://a.com/?country_code=TW"), "https://a.com/?country_code=REDACTED");
});
test("redactUrlsInText: every URL in free text, trailing punctuation kept", () => {
  assert.equal(
    redactUrlsInText("fail (https://a.com/x?token=t). see https://b.com/y?sig=s, ok"),
    "fail (https://a.com/x?token=REDACTED). see https://b.com/y?sig=REDACTED, ok",
  );
  assert.equal(redactUrlsInText("at f (https://a.com/app.js?key=k:12:5)"), "at f (https://a.com/app.js?key=REDACTED)");
});
test("redactUrl: unparseable URLs with :// still redacted", () => {
  assert.equal(redactUrl("https://a.com:abc/x?token=S"), "https://a.com:abc/x?token=REDACTED");
  assert.equal(redactUrl("https://u:p@a.com:abc/x#sig=S"), "https://REDACTED@a.com:abc/x#sig=REDACTED");
  assert.equal(redactUrl("not a url"), "not a url");
});
test("redactUrl: concatenated lowercase names", () => {
  assert.equal(redactUrl("https://a.com/?secretkey=x"), "https://a.com/?secretkey=REDACTED");
  assert.equal(redactUrl("https://a.com/?authtoken=x"), "https://a.com/?authtoken=REDACTED");
  assert.equal(redactUrl("https://a.com/?passcode=x"), "https://a.com/?passcode=REDACTED");
  assert.equal(redactUrl("https://a.com/?keyword=x"), "https://a.com/?keyword=x");
});
test("redactUrl: percent-encoded param name", () => {
  assert.equal(redactUrl("https://a.com/?tok%65n=S"), "https://a.com/?tok%65n=REDACTED");
});
