"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { acceleratorFromEvent } = require("../src/hotkey_capture");

test("preserves physical Command and Control independently on macOS", () => {
  assert.equal(acceleratorFromEvent({
    key: " ", code: "Space", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false,
  }, "darwin"), "Command+Space");
  assert.equal(acceleratorFromEvent({
    key: " ", code: "Space", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false,
  }, "darwin"), "Control+Space");
  assert.equal(acceleratorFromEvent({
    key: "k", code: "KeyK", metaKey: true, ctrlKey: true, altKey: false, shiftKey: false,
  }, "darwin"), "Command+Control+K");
});

test("preserves Control and Super independently off macOS", () => {
  assert.equal(acceleratorFromEvent({
    key: "d", code: "KeyD", metaKey: true, ctrlKey: true, altKey: true, shiftKey: false,
  }, "win32"), "Control+Super+Alt+D");
});
