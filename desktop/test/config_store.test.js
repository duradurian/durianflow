"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { loadJsonConfig, writeJsonAtomic } = require("../src/config_store");

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openflow-config-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("atomic config writes replace complete JSON and leave no temporary file", (t) => {
  const directory = temporaryDirectory(t);
  const filePath = path.join(directory, "config.json");
  writeJsonAtomic(filePath, { version: 1 });
  writeJsonAtomic(filePath, { version: 2, enabled: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), { version: 2, enabled: true });
  assert.deepEqual(fs.readdirSync(directory), ["config.json"]);
});

test("invalid config is quarantined instead of overwritten", (t) => {
  const directory = temporaryDirectory(t);
  const filePath = path.join(directory, "config.json");
  fs.writeFileSync(filePath, "{truncated", "utf8");
  const result = loadJsonConfig(filePath, { safe: true }, (value) => value);
  assert.deepEqual(result.value, { safe: true });
  assert.match(result.warning, /backed up/i);
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(fs.readFileSync(result.backupPath, "utf8"), "{truncated");
});

test("missing config loads defaults without a warning", (t) => {
  const filePath = path.join(temporaryDirectory(t), "config.json");
  const result = loadJsonConfig(filePath, { safe: true }, (value) => value);
  assert.deepEqual(result, { value: { safe: true }, warning: "", backupPath: "" });
});
