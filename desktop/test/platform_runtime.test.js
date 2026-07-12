"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  pythonCandidates,
  resolveBackendDirectory,
  resolvePythonCommand,
} = require("../src/platform_runtime");

test("uses POSIX virtualenv and python3 candidates on macOS", () => {
  const candidates = pythonCandidates({ backendDir: "/app/backend", platform: "darwin" });
  assert.deepEqual(candidates, [
    path.join("/app/backend", ".venv", "bin", "python"),
    path.join("/app/backend", ".venv", "bin", "python3"),
    "python3",
    "python",
  ]);
  assert.equal(
    resolvePythonCommand({ backendDir: "/missing/backend", platform: "darwin" }),
    "python3",
  );
});

test("retains the Windows virtualenv layout and honors an explicit interpreter", () => {
  assert.deepEqual(
    pythonCandidates({ backendDir: "C:\\app\\backend", platform: "win32" }),
    [path.join("C:\\app\\backend", ".venv", "Scripts", "python.exe"), "python"],
  );
  assert.equal(
    resolvePythonCommand({
      backendDir: "/unused",
      platform: "darwin",
      configuredPython: "/opt/homebrew/bin/python3",
    }),
    "/opt/homebrew/bin/python3",
  );
});

test("resolves packaged backend resources outside the asar", () => {
  assert.equal(
    resolveBackendDirectory({ isPackaged: true, resourcesPath: "/App/Contents/Resources" }),
    path.join("/App/Contents/Resources", "backend"),
  );
});
