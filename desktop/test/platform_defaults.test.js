"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  LEGACY_DEFAULT_HOTKEY,
  MACOS_DEFAULT_HOTKEY,
  defaultHotkey,
  migrateDefaultHotkey,
} = require("../src/platform_defaults");

test("uses a non-system-reserved first-run shortcut on macOS", () => {
  assert.equal(defaultHotkey("darwin"), MACOS_DEFAULT_HOTKEY);
  assert.equal(defaultHotkey("win32"), LEGACY_DEFAULT_HOTKEY);
});

test("migrates only the retired macOS default shortcut", () => {
  assert.equal(migrateDefaultHotkey(LEGACY_DEFAULT_HOTKEY, "darwin"), MACOS_DEFAULT_HOTKEY);
  assert.equal(migrateDefaultHotkey("Command+Option+K", "darwin"), "Command+Option+K");
  assert.equal(migrateDefaultHotkey(LEGACY_DEFAULT_HOTKEY, "win32"), LEGACY_DEFAULT_HOTKEY);
});
