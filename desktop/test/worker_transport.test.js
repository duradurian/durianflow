"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { LocalWorkerTransport } = require("../src/local_worker_transport");
const { WorkerSupervisor } = require("../src/worker_supervisor");

class FakeSupervisor extends EventEmitter {
  constructor() {
    super();
    this.options = { maxAudioBytes: 64 * 1024 };
    this.state = "ready";
    this.modelState = "ready";
    this.sent = [];
    this.sendError = null;
  }

  send(message) {
    if (this.sendError) throw this.sendError;
    this.sent.push(message);
  }

  start() { return Promise.resolve(); }
  stop() { return Promise.resolve(); }
}

test("worker_ready replaces stale model readiness and protocol errors are ordinary events", () => {
  const supervisor = new WorkerSupervisor({ command: "unused" });
  supervisor.state = "starting";
  supervisor.modelState = "ready";
  supervisor._onMessage({ protocolVersion: 1, type: "worker_ready", modelState: "loading" });
  assert.equal(supervisor.state, "ready");
  assert.equal(supervisor.modelState, "loading");

  let workerError;
  supervisor.once("worker_error", (event) => { workerError = event; });
  assert.doesNotThrow(() => {
    supervisor._onMessage({ protocolVersion: 1, type: "error", code: "MODEL_UNAVAILABLE" });
  });
  assert.equal(workerError.code, "MODEL_UNAVAILABLE");
});

test("transport ignores stale credits and clears terminal state before listeners run", () => {
  const supervisor = new FakeSupervisor();
  const transport = new LocalWorkerTransport({ supervisor });
  transport.on("error", () => {});
  const session = transport.start({ sessionId: "current" });

  assert.equal(transport.sendAudio(Buffer.alloc(2)), false);
  assert.equal(supervisor.sent.length, 1);

  supervisor.emit("event", {
    type: "accepted",
    sessionId: "old",
    generation: session.generation - 1,
    creditBytes: 1024,
  });
  assert.equal(transport.creditBytes, 0);

  supervisor.emit("event", {
    type: "accepted",
    sessionId: "current",
    generation: session.generation,
    creditBytes: 1024,
  });
  assert.equal(transport.sendAudio(Buffer.alloc(2)), true);

  supervisor.emit("event", {
    type: "status",
    status: "stopped",
    sessionId: "current",
    generation: session.generation,
  });
  assert.equal(transport.session.id, "current");

  let clearedBeforeNotification = false;
  transport.once("stopped", () => { clearedBeforeNotification = transport.session === null; });
  supervisor.emit("event", {
    type: "stopped",
    sessionId: "current",
    generation: session.generation,
  });
  assert.equal(clearedBeforeNotification, true);
  assert.equal(transport.creditBytes, 0);
});

test("failed start rolls back the local session", () => {
  const supervisor = new FakeSupervisor();
  const transport = new LocalWorkerTransport({ supervisor });
  supervisor.sendError = new Error("write failed");
  assert.throws(() => transport.start({ sessionId: "session" }), /write failed/);
  assert.equal(transport.session, null);
});

test("terminal commands are monotonic, idempotent, and cancel can supersede stop", () => {
  const supervisor = new FakeSupervisor();
  const transport = new LocalWorkerTransport({ supervisor });
  const session = transport.start({ sessionId: "session" });
  supervisor.emit("event", {
    type: "accepted",
    sessionId: "session",
    generation: session.generation,
    creditBytes: 1024,
  });

  assert.equal(transport.stop(), true);
  assert.equal(transport.stop(), true);
  assert.equal(transport.cancel(), true);
  assert.equal(transport.stop(), true);

  const terminal = supervisor.sent.filter((message) => message.type === "stop" || message.type === "cancel");
  assert.deepEqual(terminal.map((message) => [message.type, message.sequence]), [
    ["stop", 1],
    ["cancel", 2],
  ]);
});
