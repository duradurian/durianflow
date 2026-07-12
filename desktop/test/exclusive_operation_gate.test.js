"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { ExclusiveOperationGate } = require("../src/exclusive_operation_gate");

test("reserves the whole model mutation transaction until its owner releases it", () => {
  const gate = new ExclusiveOperationGate("model operation active");
  const download = gate.reserve("download");

  assert.doesNotThrow(() => gate.assertAvailable(download));
  assert.throws(() => gate.assertAvailable(), /model operation active/);
  assert.throws(() => gate.reserve("delete"), /model operation active/);

  gate.release({ label: "download" });
  assert.throws(() => gate.assertAvailable(), /model operation active/);
  gate.release(download);
  assert.doesNotThrow(() => gate.assertAvailable());
});

test("waits for the owning process to release the gate", async () => {
  const gate = new ExclusiveOperationGate();
  const cleanup = gate.reserve("cleanup");
  let released = false;

  const waiting = gate.waitForRelease(cleanup).then(() => {
    released = true;
  });
  await Promise.resolve();
  assert.equal(released, false);

  gate.release({ label: "cleanup" });
  await Promise.resolve();
  assert.equal(released, false);

  gate.release(cleanup);
  await waiting;
  assert.equal(released, true);
  await gate.waitForRelease(cleanup);
});
