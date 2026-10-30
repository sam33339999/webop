import { test } from "node:test";
import assert from "node:assert/strict";
import { siteOf } from "../src/domain.ts";

test("etld+1", () => assert.equal(siteOf("https://mail.google.com/x"), "google.com"));
test("multi-part tld", () => assert.equal(siteOf("https://a.b.example.co.uk"), "example.co.uk"));
test("localhost", () => assert.equal(siteOf("http://localhost:3000/"), "localhost"));
test("ip", () => assert.equal(siteOf("http://127.0.0.1:8080/"), "127.0.0.1"));
test("non-http null", () => assert.equal(siteOf("chrome://settings"), null));
test("private suffix github.io is per-app", () => {
  assert.equal(siteOf("https://alice.github.io/"), "alice.github.io");
  assert.equal(siteOf("https://evil.github.io/"), "evil.github.io");
  assert.equal(siteOf("https://docs.alice.github.io/x"), "alice.github.io");
});
test("private suffix vercel.app", () => assert.equal(siteOf("https://myapp.vercel.app/"), "myapp.vercel.app"));
test("private suffix blogspot.com", () => assert.equal(siteOf("https://foo.blogspot.com/"), "foo.blogspot.com"));
test("private suffix amazonaws.com", () => assert.equal(siteOf("https://bucket.s3.amazonaws.com/"), "bucket.s3.amazonaws.com"));
test("whatwg host normalisation of numeric hosts", () => {
  assert.equal(siteOf("http://0x7f.1/"), "127.0.0.1");
  assert.equal(siteOf("http://2130706433/"), "127.0.0.1");
});
test("bare suffix github.io falls back to hostname", () => assert.equal(siteOf("https://github.io/"), "github.io"));
test("plain github.com unaffected", () => assert.equal(siteOf("https://gist.github.com/"), "github.com"));
test("garbage null", () => assert.equal(siteOf("not a url"), null));
