"use strict";

const fs = require("fs");
const path = require("path");

function cloneFallback(value) {
  return value && typeof value === "object" ? { ...value } : value;
}

function corruptBackupPath(filePath, now = Date.now()) {
  return `${filePath}.corrupt-${now}-${process.pid}`;
}

function loadJsonConfig(filePath, fallback, sanitize) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return { value: sanitize(parsed), warning: "", backupPath: "" };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { value: cloneFallback(fallback), warning: "", backupPath: "" };
    }

    let backupPath = "";
    try {
      backupPath = corruptBackupPath(filePath);
      fs.renameSync(filePath, backupPath);
    } catch {
      backupPath = "";
    }
    return {
      value: cloneFallback(fallback),
      warning: backupPath
        ? `Invalid settings were backed up to ${path.basename(backupPath)}.`
        : "Settings could not be read; defaults were loaded without replacing the existing file.",
      backupPath,
    };
  }
}

function writeJsonAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    const descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch {}
    throw error;
  }
}

module.exports = { corruptBackupPath, loadJsonConfig, writeJsonAtomic };
