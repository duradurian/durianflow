"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { isLocalHost, sanitizeHttpServiceUrl } = require("../src/url_policy");

const fallback = "http://localhost:8080/v1/chat/completions";

test("recognizes IPv4, hostname, and bracketed IPv6 loopback addresses", () => {
  assert.equal(isLocalHost("localhost"), true);
  assert.equal(isLocalHost("127.0.0.1"), true);
  assert.equal(isLocalHost("[::1]"), true);
  assert.equal(isLocalHost("::1"), true);
});

test("allows local HTTP services and blocks remote services by default", () => {
  assert.equal(
    sanitizeHttpServiceUrl("http://[::1]:11434", fallback, false),
    "http://[::1]:11434/",
  );
  assert.equal(
    sanitizeHttpServiceUrl("https://example.com/api", fallback, false),
    fallback,
  );
  assert.equal(
    sanitizeHttpServiceUrl("https://example.com/api", fallback, true),
    "https://example.com/api",
  );
});

test("rejects non-HTTP protocols", () => {
  assert.equal(sanitizeHttpServiceUrl("file:///tmp/socket", fallback, true), fallback);
});
