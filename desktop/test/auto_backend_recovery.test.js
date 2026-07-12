"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { AutoBackendRecovery } = require("../src/auto_backend_recovery");

test("tracks native backend failures per speech model", () => {
  const recovery = new AutoBackendRecovery();

  assert.equal(recovery.record("small", "mlx"), true);
  assert.equal(recovery.record("small", "mlx"), false);
  assert.equal(recovery.record("small", "cuda"), true);
  assert.deepEqual(recovery.disabledFor("small"), ["mlx", "cuda"]);
  assert.deepEqual(recovery.disabledFor("large-v3"), []);
});

test("clears one recovered backend or all recovery state", () => {
  const recovery = new AutoBackendRecovery();
  recovery.record("small", "mlx");
  recovery.record("small", "cuda");
  recovery.clear("small", "mlx");
  assert.deepEqual(recovery.disabledFor("small"), ["cuda"]);
  recovery.clearAll();
  assert.equal(recovery.count("small"), 0);
});
