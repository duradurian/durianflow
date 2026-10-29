"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { acceleratorFromEvent } = require("../src/hotkey_capture");

test("settings script starts after loading the browser hotkey helper", () => {
  const settingsStarted = new Error("Settings initialization started");
  const context = vm.createContext({
    window: {},
    document: { getElementById() { throw settingsStarted; } },
  });
  const source = (name) => fs.readFileSync(path.join(__dirname, "../src", name), "utf8");

  vm.runInContext(source("hotkey_capture.js"), context);
  assert.throws(
    () => vm.runInContext(source("settings.js"), context),
    (error) => error === settingsStarted,
  );
});

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
