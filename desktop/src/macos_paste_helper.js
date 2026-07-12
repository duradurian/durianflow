"use strict";

const { execFile } = require("child_process");

const CURRENT_TARGET_JXA = String.raw`
ObjC.import("AppKit");
ObjC.import("CoreGraphics");

function currentTarget() {
  const frontmost = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (!frontmost) return null;
  const processId = Number(frontmost.processIdentifier);
  const options = $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements;
  const rawWindows = $.CGWindowListCopyWindowInfo(options, $.kCGNullWindowID);
  const windows = ObjC.deepUnwrap(rawWindows) || [];
  let focused = null;
  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];
    if (
      Number(window.kCGWindowOwnerPID) === processId
      && Number(window.kCGWindowLayer) === 0
    ) {
      focused = window;
      break;
    }
  }
  if (!focused) return null;
  return {
    processId: String(processId),
    window: String(focused.kCGWindowNumber),
  };
}
`;

const CAPTURE_SCRIPT = `${CURRENT_TARGET_JXA}
function run() {
  return JSON.stringify(currentTarget());
}`;

const AUTOMATION_PREFLIGHT_SCRIPT = String.raw`
function run() {
  const systemEvents = Application("System Events");
  // A harmless AppleEvent makes macOS resolve Automation consent before the
  // focus-sensitive validation and Command-V happen in the next process.
  systemEvents.name();
  return JSON.stringify({ status: "ready" });
}`;

const PASTE_SCRIPT = `${CURRENT_TARGET_JXA}
function run(argv) {
  const expected = { processId: String(argv[0] || ""), window: String(argv[1] || "") };
  const actual = currentTarget();
  if (!actual || actual.processId !== expected.processId || actual.window !== expected.window) {
    return JSON.stringify({ status: "focus_changed" });
  }
  const systemEvents = Application("System Events");
  systemEvents.keystroke("v", { using: ["command down"] });
  return JSON.stringify({ status: "pasted" });
}`;

function validMacTarget(target) {
  return Boolean(
    target
    && /^\d+$/.test(String(target.processId || ""))
    && /^\d+$/.test(String(target.window || "")),
  );
}

function parseResult(stdout) {
  const lines = String(stdout || "").trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return null;
  try {
    return JSON.parse(lines.at(-1));
  } catch {
    return null;
  }
}

function permissionDenied(error) {
  const message = `${error?.message || ""}\n${error?.stderr || ""}`.toLowerCase();
  return message.includes("assistive access")
    || message.includes("accessibility")
    || message.includes("-1719");
}

function automationDenied(error) {
  const message = `${error?.message || ""}\n${error?.stderr || ""}`.toLowerCase();
  return message.includes("-1743")
    || message.includes("not authorized to send apple events");
}

class MacOSPasteHelper {
  constructor({ exec = execFile, timeoutMs = 2500, permissionTimeoutMs = 15000 } = {}) {
    this.exec = exec;
    this.timeoutMs = timeoutMs;
    this.permissionTimeoutMs = permissionTimeoutMs;
    this.automationReady = false;
  }

  start() {
    return Promise.resolve(true);
  }

  stop() {
    return Promise.resolve();
  }

  _run(script, args = [], timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      this.exec(
        "/usr/bin/osascript",
        ["-l", "JavaScript", "-e", script, "--", ...args],
        { timeout: timeoutMs, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) {
            error.stderr = stderr;
            reject(error);
            return;
          }
          resolve(parseResult(stdout));
        },
      );
    });
  }

  async captureForeground() {
    try {
      const target = await this._run(CAPTURE_SCRIPT);
      return validMacTarget(target) ? target : null;
    } catch {
      return null;
    }
  }

  async pasteIfFocused(expectedTarget) {
    if (!validMacTarget(expectedTarget)) return { status: "focus_changed" };
    try {
      if (!this.automationReady) {
        const preflight = await this._run(
          AUTOMATION_PREFLIGHT_SCRIPT,
          [],
          this.permissionTimeoutMs,
        );
        if (preflight?.status !== "ready") return { status: "unknown" };
        this.automationReady = true;
      }
      const result = await this._run(PASTE_SCRIPT, [
        String(expectedTarget.processId),
        String(expectedTarget.window),
      ]);
      return result?.status ? result : { status: "unknown" };
    } catch (error) {
      if (automationDenied(error)) return { status: "automation_denied" };
      if (permissionDenied(error)) return { status: "accessibility_denied" };
      // A timeout or process failure can happen after Command-V was dispatched;
      // never retry an ambiguous macOS paste.
      return { status: "unknown" };
    }
  }
}

module.exports = {
  AUTOMATION_PREFLIGHT_SCRIPT,
  CAPTURE_SCRIPT,
  CURRENT_TARGET_JXA,
  MacOSPasteHelper,
  PASTE_SCRIPT,
  parseResult,
  automationDenied,
  permissionDenied,
  validMacTarget,
};
