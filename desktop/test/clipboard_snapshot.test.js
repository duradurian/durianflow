"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { captureClipboard, restoreClipboard } = require("../src/clipboard_snapshot");

function fakeClipboard(overrides = {}) {
  const image = { isEmpty: () => true };
  return {
    availableFormats: () => [],
    readText: () => "",
    readHTML: () => "",
    readRTF: () => "",
    readImage: () => image,
    readBookmark: () => ({ title: "", url: "" }),
    write: () => {},
    clear: () => {},
    ...overrides,
  };
}

test("captures and restores standard rich clipboard formats together", () => {
  const image = { isEmpty: () => false };
  let restored;
  const clipboard = fakeClipboard({
    availableFormats: () => ["text/plain", "text/html", "text/rtf", "image/png"],
    readText: () => "plain",
    readHTML: () => "<b>plain</b>",
    readRTF: () => "{\\rtf1 plain}",
    readImage: () => image,
    write: (data) => { restored = data; },
  });

  const snapshot = captureClipboard(clipboard);
  assert.equal(restoreClipboard(clipboard, snapshot), true);
  assert.deepEqual(restored, {
    text: "plain",
    html: "<b>plain</b>",
    rtf: "{\\rtf1 plain}",
    image,
  });
});

test("restores an originally empty clipboard", () => {
  let cleared = false;
  const clipboard = fakeClipboard({ clear: () => { cleared = true; } });
  assert.equal(restoreClipboard(clipboard, captureClipboard(clipboard)), true);
  assert.equal(cleared, true);
});

test("leaves the transcript intact when only unknown formats were present", () => {
  let wrote = false;
  let cleared = false;
  const clipboard = fakeClipboard({
    availableFormats: () => ["application/x-custom"],
    write: () => { wrote = true; },
    clear: () => { cleared = true; },
  });
  assert.equal(restoreClipboard(clipboard, captureClipboard(clipboard)), false);
  assert.equal(wrote, false);
  assert.equal(cleared, false);
});
