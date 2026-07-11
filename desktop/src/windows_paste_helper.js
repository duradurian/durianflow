"use strict";

const { spawn } = require("child_process");

const POWERSHELL_HELPER_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class DurianflowInput {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
}
"@

function Get-DurianflowForegroundTarget {
  $window = [DurianflowInput]::GetForegroundWindow()
  [uint32]$foregroundProcessId = 0
  if ($window -ne [IntPtr]::Zero) {
    [void][DurianflowInput]::GetWindowThreadProcessId($window, [ref]$foregroundProcessId)
  }
  return @{
    window = $window.ToInt64().ToString()
    processId = $foregroundProcessId.ToString()
  }
}

# Pay PowerShell function compilation and the first user32 call during app
# warm-up instead of on the first hotkey press.
[void](Get-DurianflowForegroundTarget)
[void](ConvertFrom-Json -InputObject '{"id":0}')
[void](@{ id = 0; status = "warm" } | ConvertTo-Json -Compress)
[Console]::Out.WriteLine('{"type":"ready"}')
[Console]::Out.Flush()

while (($line = [Console]::In.ReadLine()) -ne $null) {
  [long]$requestId = 0
  try {
    $request = ConvertFrom-Json -InputObject $line
    $requestId = [long]$request.id
    $target = Get-DurianflowForegroundTarget

    if ($request.command -eq "foreground") {
      if ($target.window -eq "0" -or $target.processId -eq "0") {
        $response = @{ id = $requestId; status = "unavailable" }
      } else {
        $response = @{
          id = $requestId
          status = "target"
          window = $target.window
          processId = $target.processId
        }
      }
    } elseif ($request.command -eq "paste") {
      if (
        $target.window -ne [string]$request.window -or
        $target.processId -ne [string]$request.processId
      ) {
        $response = @{ id = $requestId; status = "focus_changed" }
      } else {
        [System.Windows.Forms.SendKeys]::SendWait("^v")
        $response = @{ id = $requestId; status = "pasted" }
      }
    } else {
      $response = @{ id = $requestId; status = "error" }
    }
  } catch {
    $response = @{ id = $requestId; status = "error" }
  }

  [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
`;

function encodedPowerShellCommand(script = POWERSHELL_HELPER_SCRIPT) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function validTarget(target) {
  return Boolean(
    target
    && /^-?\d+$/.test(String(target.window || ""))
    && /^\d+$/.test(String(target.processId || ""))
    && String(target.window) !== "0"
    && String(target.processId) !== "0",
  );
}

function shouldUseColdPaste(result) {
  // Only an undispatched request is safe to retry. Unknown, timeout, and error
  // may mean SendKeys ran before the helper failed.
  return result?.status === "unavailable";
}

class WindowsPasteHelper {
  constructor({
    platform = process.platform,
    spawnProcess = spawn,
    startupTimeoutMs = 1500,
    foregroundTimeoutMs = 750,
    pasteTimeoutMs = 2500,
    retryDelayMs = 30_000,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.platform = platform;
    this.spawnProcess = spawnProcess;
    this.startupTimeoutMs = startupTimeoutMs;
    this.foregroundTimeoutMs = foregroundTimeoutMs;
    this.pasteTimeoutMs = pasteTimeoutMs;
    this.retryDelayMs = retryDelayMs;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.child = null;
    this.ready = false;
    this.startPromise = null;
    this.startResolve = null;
    this.startTimer = null;
    this.stdoutBuffer = "";
    this.nextRequestId = 0;
    this.pending = new Map();
    this.retryAfter = 0;
  }

  start() {
    if (this.platform !== "win32" || this.now() < this.retryAfter) return Promise.resolve(false);
    if (this.child && this.ready) return Promise.resolve(true);
    if (this.startPromise) return this.startPromise;

    let child;
    try {
      child = this.spawnProcess("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-EncodedCommand",
        encodedPowerShellCommand(),
      ], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      this._backOffStartup();
      return Promise.resolve(false);
    }

    this.child = child;
    this.ready = false;
    this.stdoutBuffer = "";
    const promise = new Promise((resolve) => {
      this.startResolve = resolve;
      this.startTimer = this.setTimer(() => {
        if (this.child === child && !this.ready) {
          this._backOffStartup();
          this._terminate(child);
        }
        this._settleStart(false);
      }, this.startupTimeoutMs);
    });
    this.startPromise = promise;
    promise.then(() => {
      if (this.startPromise === promise) this.startPromise = null;
    });

    child.stdout.on("data", (chunk) => this._onStdout(child, chunk));
    child.stdout.once?.("error", () => this._terminate(child));
    // Pipe failures are emitted asynchronously and are not caught by the
    // try/catch around stdin.write(). Treat an in-flight paste as ambiguous
    // instead of letting an unhandled EPIPE terminate Electron.
    child.stdin.once?.("error", () => this._terminate(child));
    child.once("error", () => this._onExit(child));
    child.once("exit", () => this._onExit(child));
    return promise;
  }

  async captureForeground() {
    if (!this.child || !this.ready) {
      // Let the caller use its cold foreground query now while this helper
      // warms in parallel for the eventual paste.
      this.start().catch(() => {});
      return null;
    }
    const response = await this._request("foreground", {}, this.foregroundTimeoutMs);
    const target = response?.status === "target"
      ? { window: String(response.window || ""), processId: String(response.processId || "") }
      : null;
    return validTarget(target) ? target : null;
  }

  async pasteIfFocused(expectedTarget) {
    if (!validTarget(expectedTarget)) return { status: "focus_changed" };
    // Completion must not wait for a replacement helper to cold-start. The
    // caller can immediately use its one-shot atomic fallback instead.
    if (!this.child || !this.ready) return { status: "unavailable" };
    return this._request("paste", {
      window: String(expectedTarget.window),
      processId: String(expectedTarget.processId),
    }, this.pasteTimeoutMs);
  }

  stop() {
    if (this.child) this._terminate(this.child);
    else this._settleStart(false);
    return Promise.resolve();
  }

  async _request(command, fields, timeoutMs) {
    const child = this.child;
    if (!child || !this.ready) return { status: "unavailable" };

    const id = ++this.nextRequestId;
    return new Promise((resolve) => {
      const timer = this.setTimer(() => {
        if (!this.pending.delete(id)) return;
        resolve({ status: command === "paste" ? "unknown" : "unavailable" });
        // A timed-out request leaves command/response framing ambiguous. Drop
        // this helper and start a fresh one for the next request; never retry a
        // dispatched paste because that could insert the transcript twice.
        if (this.child === child) this._terminate(child);
      }, timeoutMs);
      this.pending.set(id, { command, resolve, timer });

      try {
        child.stdin.write(`${JSON.stringify({ id, command, ...fields })}\n`);
      } catch {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        this.clearTimer(timer);
        resolve({ status: command === "paste" ? "unknown" : "unavailable" });
        if (this.child === child) this._terminate(child);
      }
    });
  }

  _onStdout(child, chunk) {
    if (this.child !== child) return;
    this.stdoutBuffer += String(chunk || "");
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message?.type === "ready") {
        this.ready = true;
        this.retryAfter = 0;
        this._settleStart(true);
        continue;
      }
      const id = Number(message?.id);
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      this.clearTimer(pending.timer);
      pending.resolve(message);
    }
  }

  _settleStart(result) {
    if (this.startTimer !== null) {
      this.clearTimer(this.startTimer);
      this.startTimer = null;
    }
    const resolve = this.startResolve;
    this.startResolve = null;
    if (resolve) resolve(result);
  }

  _onExit(child) {
    if (this.child !== child) return;
    const exitedBeforeReady = !this.ready;
    this.child = null;
    this.ready = false;
    this.stdoutBuffer = "";
    if (exitedBeforeReady) this._backOffStartup();
    this._settleStart(false);
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      this.clearTimer(pending.timer);
      pending.resolve({ status: pending.command === "paste" ? "unknown" : "unavailable" });
    }
  }

  _terminate(child) {
    this._onExit(child);
    try { child.stdin?.end(); } catch {}
    try { child.kill(); } catch {}
  }

  _backOffStartup() {
    this.retryAfter = this.now() + this.retryDelayMs;
  }
}

module.exports = {
  POWERSHELL_HELPER_SCRIPT,
  WindowsPasteHelper,
  encodedPowerShellCommand,
  shouldUseColdPaste,
  validTarget,
};
