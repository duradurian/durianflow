"use strict";

const LEGACY_DEFAULT_HOTKEY = "CommandOrControl+Alt+Space";
const MACOS_DEFAULT_HOTKEY = "Command+Shift+Space";

function defaultHotkey(platform = process.platform) {
  return platform === "darwin" ? MACOS_DEFAULT_HOTKEY : LEGACY_DEFAULT_HOTKEY;
}

function migrateDefaultHotkey(value, platform = process.platform) {
  if (platform === "darwin" && value === LEGACY_DEFAULT_HOTKEY) {
    return MACOS_DEFAULT_HOTKEY;
  }
  return value;
}

module.exports = {
  LEGACY_DEFAULT_HOTKEY,
  MACOS_DEFAULT_HOTKEY,
  defaultHotkey,
  migrateDefaultHotkey,
};
