"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DESKTOP_PARTIAL_INTERVAL_MS,
  desktopWorkerEnvironment,
} = require("../src/desktop_latency_policy");

test("desktop worker policy overrides ambient rolling partial inference", () => {
  const environment = desktopWorkerEnvironment({
    PATH: "example",
    PARTIAL_INTERVAL_MS: "1000",
  });

  assert.equal(environment.PATH, "example");
  assert.equal(environment.PARTIAL_INTERVAL_MS, String(Number.MAX_SAFE_INTEGER));
  assert.equal(DESKTOP_PARTIAL_INTERVAL_MS, Number.MAX_SAFE_INTEGER);
});
