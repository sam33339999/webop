import { test } from "node:test";
import assert from "node:assert/strict";
import { siteOf } from "../src/domain.ts";

test("etld+1", () => assert.equal(siteOf("https://mail.google.com/x"), "google.com"));
test("multi-part tld", () => assert.equal(siteOf("https://a.b.example.co.uk"), "example.co.uk"));
test("localhost", () => assert.equal(siteOf("http://localhost:3000/"), "localhost"));
test("ip", () => assert.equal(siteOf("http://127.0.0.1:8080/"), "127.0.0.1"));
test("non-http null", () => assert.equal(siteOf("chrome://settings"), null));
