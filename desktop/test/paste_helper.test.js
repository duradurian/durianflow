"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { MacOSPasteHelper } = require("../src/macos_paste_helper");
const { ClipboardOnlyPasteHelper, createPasteHelper } = require("../src/paste_helper");
const { WindowsPasteHelper } = require("../src/windows_paste_helper");

test("selects a paste implementation for each desktop platform", () => {
  assert.ok(createPasteHelper("darwin") instanceof MacOSPasteHelper);
  assert.ok(createPasteHelper("win32") instanceof WindowsPasteHelper);
  assert.ok(createPasteHelper("linux") instanceof ClipboardOnlyPasteHelper);
});
