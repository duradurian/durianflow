"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { modelManagementBackend } = require("../src/speech_model_backend");

const ready = { worker: "ready", model: "ready" };

test("uses a resolved automatic backend only for the matching ready model", () => {
  assert.equal(modelManagementBackend({
    configuredBackend: "auto",
    activeBackend: "cpu",
    workerConfiguredBackend: "auto",
    activeModel: "small",
    requestedModel: "small",
    workerState: ready,
  }), "cpu");
});

test("does not reuse the other profile's model-specific fallback", () => {
  assert.equal(modelManagementBackend({
    configuredBackend: "auto",
    activeBackend: "cpu",
    workerConfiguredBackend: "auto",
    activeModel: "small",
    requestedModel: "large-v3-turbo",
    workerState: ready,
  }), "auto");
});

test("does not reuse a stale backend while replacing or stopping a worker", () => {
  assert.equal(modelManagementBackend({
    configuredBackend: "auto",
    activeBackend: "cpu",
    workerConfiguredBackend: "cpu",
    activeModel: "small",
    requestedModel: "small",
    workerState: ready,
  }), "auto");
  assert.equal(modelManagementBackend({
    configuredBackend: "auto",
    activeBackend: "mlx",
    workerConfiguredBackend: "auto",
    activeModel: "small",
    requestedModel: "small",
    workerState: { worker: "stopped", model: "unknown" },
  }), "auto");
});

test("explicit backend selection remains authoritative", () => {
  assert.equal(modelManagementBackend({
    configuredBackend: "cuda",
    activeBackend: "cpu",
    workerConfiguredBackend: "auto",
    activeModel: "small",
    requestedModel: "large-v3",
    workerState: null,
  }), "cuda");
});
