"use strict";

class ExclusiveOperationGate {
  constructor(message = "An exclusive operation is already in progress.") {
    this.message = message;
    this.active = null;
    this.releaseWaiters = new Map();
  }

  reserve(label) {
    this.assertAvailable();
    const token = { label: String(label || "operation") };
    this.active = token;
    return token;
  }

  assertAvailable(token = null) {
    if (this.active && this.active !== token) throw new Error(this.message);
  }

  release(token) {
    if (this.active !== token) return;
    this.active = null;
    const waiters = this.releaseWaiters.get(token) || [];
    this.releaseWaiters.delete(token);
    for (const resolve of waiters) resolve();
  }

  waitForRelease(token) {
    if (this.active !== token) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.releaseWaiters.get(token) || [];
      waiters.push(resolve);
      this.releaseWaiters.set(token, waiters);
    });
  }
}

module.exports = { ExclusiveOperationGate };
