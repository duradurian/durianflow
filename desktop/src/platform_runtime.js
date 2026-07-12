"use strict";

const fs = require("fs");
const path = require("path");

function resolveBackendDirectory({
  isPackaged = false,
  resourcesPath = process.resourcesPath,
  sourceRoot,
} = {}) {
  if (isPackaged) return path.join(resourcesPath, "backend");
  if (!sourceRoot) throw new TypeError("sourceRoot is required for an unpackaged app");
  return path.join(sourceRoot, "backend");
}

function pythonCandidates({
  backendDir,
  platform = process.platform,
  configuredPython = "",
} = {}) {
  const configured = String(configuredPython || "").trim();
  if (configured) return [configured];
  if (platform === "win32") {
    return [
      path.join(backendDir, ".venv", "Scripts", "python.exe"),
      "python",
    ];
  }
  return [
    path.join(backendDir, ".venv", "bin", "python"),
    path.join(backendDir, ".venv", "bin", "python3"),
    "python3",
    "python",
  ];
}

function resolvePythonCommand(options = {}) {
  const candidates = pythonCandidates(options);
  return candidates.find((candidate) => (
    path.isAbsolute(candidate) && fs.existsSync(candidate)
  )) || candidates.find((candidate) => !path.isAbsolute(candidate)) || candidates[0];
}

module.exports = {
  pythonCandidates,
  resolveBackendDirectory,
  resolvePythonCommand,
};
