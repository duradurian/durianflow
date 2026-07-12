"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  AUTOMATION_PREFLIGHT_SCRIPT,
  MacOSPasteHelper,
  PASTE_SCRIPT,
  validMacTarget,
} = require("../src/macos_paste_helper");

test("captures and revalidates an exact macOS process/window target", async () => {
  const calls = [];
  const exec = (command, args, options, callback) => {
    calls.push({ command, args, options });
    const isPaste = args[3] === PASTE_SCRIPT;
    const isPreflight = args[3] === AUTOMATION_PREFLIGHT_SCRIPT;
    callback(
      null,
      JSON.stringify(
        isPaste
          ? { status: "pasted" }
          : isPreflight
            ? { status: "ready" }
            : { processId: "42", window: "99" },
      ),
      "",
    );
  };
  const helper = new MacOSPasteHelper({ exec });

  const target = await helper.captureForeground();
  assert.deepEqual(target, { processId: "42", window: "99" });
  assert.deepEqual(await helper.pasteIfFocused(target), { status: "pasted" });
  assert.equal(calls[1].args[3], AUTOMATION_PREFLIGHT_SCRIPT);
  assert.equal(calls[2].args.at(-2), "42");
  assert.equal(calls[2].args.at(-1), "99");
  assert.equal(calls[1].options.timeout, 15000);
});

test("reports Automation denial and never attempts an invalid target", async () => {
  let calls = 0;
  const helper = new MacOSPasteHelper({
    exec: (_command, _args, _options, callback) => {
      calls += 1;
      const error = new Error("osascript is not authorized to send Apple events (-1743)");
      callback(error, "", error.message);
    },
  });

  assert.equal(validMacTarget({ processId: "1", window: "2" }), true);
  assert.deepEqual(await helper.pasteIfFocused(null), { status: "focus_changed" });
  assert.equal(calls, 0);
  assert.deepEqual(
    await helper.pasteIfFocused({ processId: "1", window: "2" }),
    { status: "automation_denied" },
  );
  assert.equal(calls, 1);
});

test("reports Accessibility denial separately from Automation denial", async () => {
  const helper = new MacOSPasteHelper({
    exec: (_command, args, _options, callback) => {
      if (args[3] === AUTOMATION_PREFLIGHT_SCRIPT) {
        callback(null, JSON.stringify({ status: "ready" }), "");
        return;
      }
      const error = new Error("System Events is not allowed assistive access (-1719)");
      callback(error, "", error.message);
    },
  });

  assert.deepEqual(
    await helper.pasteIfFocused({ processId: "1", window: "2" }),
    { status: "accessibility_denied" },
  );
});

test("treats a failed paste process as ambiguous to prevent duplicate insertion", async () => {
  const helper = new MacOSPasteHelper({
    exec: (_command, args, _options, callback) => {
      if (args[3] === AUTOMATION_PREFLIGHT_SCRIPT) {
        callback(null, JSON.stringify({ status: "ready" }), "");
        return;
      }
      callback(new Error("timed out"), "", "");
    },
  });

  assert.deepEqual(
    await helper.pasteIfFocused({ processId: "1", window: "2" }),
    { status: "unknown" },
  );
});

test("resolves Automation consent before the focus-sensitive paste process", async () => {
  const scripts = [];
  const helper = new MacOSPasteHelper({
    exec: (_command, args, _options, callback) => {
      scripts.push(args[3]);
      callback(
        null,
        JSON.stringify(args[3] === AUTOMATION_PREFLIGHT_SCRIPT
          ? { status: "ready" }
          : { status: "focus_changed" }),
        "",
      );
    },
  });

  assert.deepEqual(
    await helper.pasteIfFocused({ processId: "1", window: "2" }),
    { status: "focus_changed" },
  );
  assert.deepEqual(scripts, [AUTOMATION_PREFLIGHT_SCRIPT, PASTE_SCRIPT]);
});
