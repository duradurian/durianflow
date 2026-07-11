"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  POWERSHELL_HELPER_SCRIPT,
  shouldUseColdPaste,
  WindowsPasteHelper,
  validTarget,
} = require("../src/windows_paste_helper");

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.writes = [];
    this.killed = false;
    this.stdin = new EventEmitter();
    this.stdin.write = (value) => { this.writes.push(String(value)); return true; };
    this.stdin.end = () => {};
  }

  kill() { this.killed = true; }

  request(index = this.writes.length - 1) {
    return JSON.parse(this.writes[index]);
  }

  respond(message) {
    this.stdout.emit("data", `${JSON.stringify(message)}\n`);
  }
}

function helperFixture() {
  const children = [];
  const helper = new WindowsPasteHelper({
    platform: "win32",
    spawnProcess: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  });
  return { children, helper };
}

function timerFixture() {
  let nextId = 0;
  const timers = new Map();
  return {
    clearTimer: (id) => timers.delete(id),
    fireLast: () => {
      const entry = [...timers.entries()].at(-1);
      assert.ok(entry, "expected a pending timer");
      timers.delete(entry[0]);
      entry[1]();
    },
    setTimer: (callback) => {
      const id = ++nextId;
      timers.set(id, callback);
      return id;
    },
  };
}

async function ready(helper, child) {
  const started = helper.start();
  child.respond({ type: "ready" });
  assert.equal(await started, true);
}

test("reuses one warmed process for foreground capture and atomic paste", async () => {
  const { children, helper } = helperFixture();
  const starting = helper.start();
  const child = children[0];
  child.respond({ type: "ready" });
  assert.equal(await starting, true);

  const capture = helper.captureForeground();
  await Promise.resolve();
  const foregroundRequest = child.request();
  child.respond({ id: foregroundRequest.id, status: "target", window: "123", processId: "456" });
  assert.deepEqual(await capture, { window: "123", processId: "456" });

  const paste = helper.pasteIfFocused({ window: "123", processId: "456" });
  await Promise.resolve();
  const pasteRequest = child.request();
  assert.deepEqual(pasteRequest, {
    id: pasteRequest.id,
    command: "paste",
    window: "123",
    processId: "456",
  });
  child.respond({ id: pasteRequest.id, status: "pasted" });
  assert.deepEqual(await paste, { id: pasteRequest.id, status: "pasted" });
  assert.equal(children.length, 1);
});

test("does not dispatch paste without a valid captured target", async () => {
  const { children, helper } = helperFixture();
  assert.equal(validTarget({ window: "123", processId: "456" }), true);
  assert.equal(validTarget({ window: "0", processId: "456" }), false);
  assert.deepEqual(await helper.pasteIfFocused(null), { status: "focus_changed" });
  assert.equal(children.length, 0);
});

test("a helper that cannot start backs off repeated warm attempts", async () => {
  let spawnCalls = 0;
  let now = 100;
  const helper = new WindowsPasteHelper({
    platform: "win32",
    now: () => now,
    retryDelayMs: 30,
    spawnProcess: () => {
      spawnCalls += 1;
      throw new Error("PowerShell blocked");
    },
  });

  assert.equal(await helper.captureForeground(), null);
  assert.deepEqual(
    await helper.pasteIfFocused({ window: "1", processId: "2" }),
    { status: "unavailable" },
  );
  assert.equal(spawnCalls, 1);
  now += 31;
  assert.equal(await helper.captureForeground(), null);
  assert.equal(spawnCalls, 2);
});

test("only an undispatched helper request is safe to send through the cold fallback", () => {
  assert.equal(shouldUseColdPaste({ status: "unavailable" }), true);
  assert.equal(shouldUseColdPaste({ status: "unknown" }), false);
  assert.equal(shouldUseColdPaste({ status: "paste_timeout" }), false);
  assert.equal(shouldUseColdPaste({ status: "error" }), false);
});

test("startup timeout backs off repeated warm-helper attempts", async () => {
  const timers = timerFixture();
  const children = [];
  const helper = new WindowsPasteHelper({
    platform: "win32",
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    spawnProcess: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  });

  const starting = helper.start();
  timers.fireLast();
  assert.equal(await starting, false);
  assert.equal(children[0].killed, true);
  assert.equal(await helper.captureForeground(), null);
  assert.equal(children.length, 1);
});

test("does not retry an ambiguously dispatched paste and restarts next time", async () => {
  const { children, helper } = helperFixture();
  const starting = helper.start();
  const first = children[0];
  first.respond({ type: "ready" });
  await starting;

  const paste = helper.pasteIfFocused({ window: "12", processId: "34" });
  await Promise.resolve();
  assert.equal(first.request().command, "paste");
  first.emit("exit", 1, null);
  assert.deepEqual(await paste, { status: "unknown" });
  assert.equal(children.length, 1);

  const coldCapture = helper.captureForeground();
  const second = children[1];
  second.respond({ type: "ready" });
  assert.equal(await coldCapture, null);
  await Promise.resolve();
  const warmCapture = helper.captureForeground();
  await Promise.resolve();
  const request = second.request();
  second.respond({ id: request.id, status: "target", window: "56", processId: "78" });
  assert.deepEqual(await warmCapture, { window: "56", processId: "78" });
  assert.equal(children.length, 2);
});

test("an asynchronous stdin failure cannot crash or duplicate a paste", async () => {
  const { children, helper } = helperFixture();
  const starting = helper.start();
  const child = children[0];
  child.respond({ type: "ready" });
  await starting;

  const paste = helper.pasteIfFocused({ window: "12", processId: "34" });
  await Promise.resolve();
  assert.equal(child.writes.length, 1);
  assert.doesNotThrow(() => child.stdin.emit("error", new Error("EPIPE")));
  assert.deepEqual(await paste, { status: "unknown" });
  assert.equal(child.writes.length, 1);
});

test("paste timeout is ambiguous, kills the helper, and restarts only later", async () => {
  const timers = timerFixture();
  const children = [];
  const helper = new WindowsPasteHelper({
    platform: "win32",
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    spawnProcess: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  });
  const starting = helper.start();
  const first = children[0];
  first.respond({ type: "ready" });
  await starting;

  const paste = helper.pasteIfFocused({ window: "12", processId: "34" });
  await Promise.resolve();
  assert.equal(first.writes.length, 1);
  timers.fireLast();
  assert.deepEqual(await paste, { status: "unknown" });
  assert.equal(first.killed, true);
  assert.equal(children.length, 1);

  const coldCapture = helper.captureForeground();
  const second = children[1];
  second.respond({ type: "ready" });
  assert.equal(await coldCapture, null);
  await Promise.resolve();
  const warmCapture = helper.captureForeground();
  await Promise.resolve();
  const request = second.request();
  second.respond({ id: request.id, status: "target", window: "56", processId: "78" });
  assert.deepEqual(await warmCapture, { window: "56", processId: "78" });
  assert.equal(children.length, 2);
});

test("correlates concurrent responses by request id", async () => {
  const { children, helper } = helperFixture();
  const starting = helper.start();
  const child = children[0];
  child.respond({ type: "ready" });
  await starting;

  const first = helper.captureForeground();
  const second = helper.captureForeground();
  await Promise.resolve();
  const firstRequest = child.request(0);
  const secondRequest = child.request(1);

  child.respond({ id: secondRequest.id, status: "target", window: "22", processId: "2" });
  child.respond({ id: firstRequest.id, status: "target", window: "11", processId: "1" });

  assert.deepEqual(await first, { window: "11", processId: "1" });
  assert.deepEqual(await second, { window: "22", processId: "2" });
});

test("PowerShell validates focus immediately before SendKeys", () => {
  const comparison = POWERSHELL_HELPER_SCRIPT.indexOf('$target.window -ne [string]$request.window');
  const paste = POWERSHELL_HELPER_SCRIPT.indexOf('SendKeys]::SendWait("^v")');
  assert.ok(comparison >= 0);
  assert.ok(paste > comparison);
});
