"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { ClipboardRestoreScheduler } = require("../src/clipboard_restore_scheduler");

test("schedules clipboard restoration without blocking paste completion", () => {
  let clipboardText = "transcript";
  let scheduled;
  let restored = false;
  const scheduler = new ClipboardRestoreScheduler({
    clipboard: { readText: () => clipboardText },
    restoreSnapshot: (_clipboard, snapshot) => {
      restored = true;
      clipboardText = snapshot.text;
      return true;
    },
    setTimer: (callback, delay) => {
      scheduled = { callback, delay };
      return 1;
    },
    clearTimer: () => {},
  });

  scheduler.schedule("transcript", { text: "original" });

  assert.equal(restored, false);
  assert.equal(scheduled.delay, 800);
  scheduled.callback();
  assert.equal(restored, true);
  assert.equal(clipboardText, "original");
});

test("flushes a pending restore before the next transcript snapshots the clipboard", () => {
  let clipboardText = "first transcript";
  const restored = [];
  const scheduler = new ClipboardRestoreScheduler({
    clipboard: { readText: () => clipboardText },
    restoreSnapshot: (_clipboard, snapshot) => {
      restored.push(snapshot.text);
      clipboardText = snapshot.text;
      return true;
    },
    setTimer: () => 1,
    clearTimer: () => {},
  });

  scheduler.schedule("first transcript", { text: "original" });
  assert.equal(scheduler.flush(), true);
  assert.deepEqual(restored, ["original"]);
});

test("does not overwrite a different text value copied by another application", () => {
  let clipboardText = "transcript";
  let restored = false;
  const scheduler = new ClipboardRestoreScheduler({
    clipboard: { readText: () => clipboardText },
    restoreSnapshot: () => { restored = true; },
    setTimer: () => 1,
    clearTimer: () => {},
  });

  scheduler.schedule("transcript", { text: "original" });
  clipboardText = "new clipboard value";

  assert.equal(scheduler.flush(), false);
  assert.equal(restored, false);
});
