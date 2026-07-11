"use strict";

class ClipboardRestoreScheduler {
  constructor({
    clipboard,
    restoreSnapshot,
    delayMs = 800,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    if (!clipboard || typeof clipboard.readText !== "function") {
      throw new TypeError("A clipboard reader is required");
    }
    if (typeof restoreSnapshot !== "function") {
      throw new TypeError("A clipboard restore function is required");
    }
    this.clipboard = clipboard;
    this.restoreSnapshot = restoreSnapshot;
    this.delayMs = delayMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.pending = null;
    this.timer = null;
  }

  schedule(expectedText, snapshot) {
    this.flush();
    this.pending = { expectedText, snapshot };
    this.timer = this.setTimer(() => this.flush(), this.delayMs);
  }

  flush() {
    if (!this.pending) return false;
    const pending = this.pending;
    this.pending = null;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    try {
      if (this.clipboard.readText() === pending.expectedText) {
        return Boolean(this.restoreSnapshot(this.clipboard, pending.snapshot));
      }
    } catch {}
    return false;
  }
}

module.exports = { ClipboardRestoreScheduler };
