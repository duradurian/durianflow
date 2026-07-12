"use strict";

const RESOLVED_BACKENDS = new Set(["mlx", "cuda", "cpu"]);

function modelManagementBackend({
  configuredBackend = "auto",
  activeBackend = null,
  workerConfiguredBackend = null,
  activeModel = null,
  requestedModel = null,
  workerState = null,
} = {}) {
  if (configuredBackend !== "auto") return configuredBackend;

  const matchingReadyWorker = (
    workerState?.worker === "ready"
    && workerState?.model === "ready"
    && workerConfiguredBackend === configuredBackend
    && activeModel === requestedModel
    && RESOLVED_BACKENDS.has(activeBackend)
  );
  return matchingReadyWorker ? activeBackend : "auto";
}

module.exports = { modelManagementBackend };
