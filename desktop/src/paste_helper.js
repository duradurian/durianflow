"use strict";

const { MacOSPasteHelper } = require("./macos_paste_helper");
const { WindowsPasteHelper } = require("./windows_paste_helper");

class ClipboardOnlyPasteHelper {
  start() { return Promise.resolve(false); }
  stop() { return Promise.resolve(); }
  captureForeground() { return Promise.resolve(null); }
  pasteIfFocused() { return Promise.resolve({ status: "unsupported" }); }
}

function createPasteHelper(platform = process.platform, options = {}) {
  if (platform === "win32") return new WindowsPasteHelper(options.windows);
  if (platform === "darwin") return new MacOSPasteHelper(options.macos);
  return new ClipboardOnlyPasteHelper();
}

module.exports = { ClipboardOnlyPasteHelper, createPasteHelper };
