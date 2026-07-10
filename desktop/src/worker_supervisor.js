"use strict";

// The local worker protocol is deliberately boring: a four byte big-endian
// length followed by one UTF-8 JSON object.  stdout is protocol-only.
const { EventEmitter } = require("events");
const { spawn } = require("child_process");

const DEFAULTS = Object.freeze({
  protocolVersion: 1,
  maxControlBytes: 64 * 1024,
  // Must match backend/app/worker_protocol.py. Audio's base64 envelope is
  // larger than a control message, hence the distinct record cap.
  maxAudioBytes: 64 * 1024,
  maxRecordBytes: 160 * 1024,
  maxQueuedBytes: 2 * 1024 * 1024,
  maxQueuedFrames: 64,
  maxStderrBytes: 64 * 1024,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 5_000,
});

class ProtocolError extends Error {
  constructor(message, code = "WORKER_PROTOCOL_ERROR") {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

class LengthPrefixedJsonParser {
  constructor({ maxBytes = DEFAULTS.maxControlBytes, onMessage }) {
    this.maxBytes = maxBytes;
    this.onMessage = onMessage;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length === 0 || length > this.maxBytes) {
        throw new ProtocolError(`Invalid worker record length: ${length}`);
      }
      if (this.buffer.length < 4 + length) return;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      let message;
      try {
        message = JSON.parse(body.toString("utf8"));
      } catch {
        throw new ProtocolError("Worker emitted malformed JSON");
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        throw new ProtocolError("Worker emitted a non-object record");
      }
      this.onMessage(message);
    }
  }
}

function encodeRecord(message, maxBytes = DEFAULTS.maxControlBytes) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length === 0 || body.length > maxBytes) {
    throw new ProtocolError(`Outgoing record exceeds ${maxBytes} byte limit`, "WORKER_MESSAGE_TOO_LARGE");
  }
  const record = Buffer.allocUnsafe(4 + body.length);
  record.writeUInt32BE(body.length, 0);
  body.copy(record, 4);
  return record;
}

function boundedAppend(existing, chunk, limit) {
  const next = Buffer.concat([existing, chunk]);
  return next.length <= limit ? next : next.subarray(next.length - limit);
}

class WorkerSupervisor extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.command) throw new TypeError("WorkerSupervisor requires a command");
    this.options = { ...DEFAULTS, ...options };
    this.child = null;
    this.state = "stopped";
    this.modelState = "unknown";
    this.stderr = Buffer.alloc(0);
    this.writeQueue = [];
    this.queuedBytes = 0;
    this.waitingDrain = false;
    this.startTimer = null;
    this.shutdownTimer = null;
    this.stopPromise = null;
    this.intentionalExit = false;
    this.controlSequence = 0;
  }

  start() {
    if (this.child) return Promise.reject(new Error("Worker is already running"));
    this.state = "starting";
    this.modelState = "unknown";
    this.intentionalExit = false;
    this.stderr = Buffer.alloc(0);
    const { command, args = [], cwd, env, windowsHide = true } = this.options;
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    const parser = new LengthPrefixedJsonParser({
      maxBytes: this.options.maxRecordBytes,
      onMessage: (message) => this._onMessage(message),
    });
    child.stdout.on("data", (chunk) => {
      try { parser.push(chunk); } catch (error) { this._protocolFailure(error); }
    });
    child.stderr.on("data", (chunk) => {
      this.stderr = boundedAppend(this.stderr, chunk, this.options.maxStderrBytes);
      this.emit("stderr", chunk.toString("utf8"));
    });
    child.stdin.on("drain", () => { this.waitingDrain = false; this._flushWrites(); });
    child.stdin.on("error", (error) => {
      if (this.child === child && !this.intentionalExit) this._protocolFailure(error);
    });
    child.once("error", (error) => this._onExit(error, null));
    child.once("exit", (code, signal) => this._onExit(null, { code, signal }));
    this.startTimer = setTimeout(() => {
      if (this.state === "starting") this._protocolFailure(new ProtocolError("Worker readiness timed out", "WORKER_START_TIMEOUT"));
    }, this.options.startupTimeoutMs);
    // A worker becomes command-safe before its model finishes loading. The
    // explicit handshake avoids readiness guesses and fixed startup delays.
    this.send({ type: "hello", sequence: this.controlSequence });
    return new Promise((resolve, reject) => {
      const ready = (message) => { cleanup(); resolve(message); };
      const failed = (error) => { cleanup(); reject(error); };
      const exited = () => failed(new ProtocolError("Worker exited before becoming ready", "WORKER_EXITED"));
      const cleanup = () => {
        this.off("ready", ready);
        this.off("fatal", failed);
        this.off("exit", exited);
      };
      this.once("ready", ready);
      this.once("fatal", failed);
      this.once("exit", exited);
    });
  }

  send(message) {
    if (!this.child || this.state === "stopped") throw new Error("Worker is not running");
    const normalized = { protocolVersion: this.options.protocolVersion, ...message };
    const record = encodeRecord(normalized, this.options.maxRecordBytes);
    if (this.queuedBytes + record.length > this.options.maxQueuedBytes || this.writeQueue.length >= this.options.maxQueuedFrames) {
      const error = new ProtocolError("Worker input queue is full", "WORKER_BACKPRESSURE");
      this.emit("backpressure", { queuedBytes: this.queuedBytes, queuedFrames: this.writeQueue.length });
      throw error;
    }
    this.writeQueue.push(record);
    this.queuedBytes += record.length;
    this._flushWrites();
  }

  _flushWrites() {
    if (!this.child || this.waitingDrain) return;
    while (this.writeQueue.length) {
      const record = this.writeQueue.shift();
      this.queuedBytes -= record.length;
      let accepted;
      try { accepted = this.child.stdin.write(record); } catch (error) { this._protocolFailure(error); return; }
      if (!accepted) { this.waitingDrain = true; return; }
    }
  }

  _onMessage(message) {
    if (message.protocolVersion !== this.options.protocolVersion || typeof message.type !== "string") {
      this._protocolFailure(new ProtocolError("Worker sent unsupported protocol record"));
      return;
    }
    if (message.type === "worker_ready") {
      if (this.state !== "starting") return;
      clearTimeout(this.startTimer);
      this.startTimer = null;
      this.modelState = String(message.modelState || "unknown");
      this.state = "ready";
      this.emit("ready", message);
    }
    if (message.type === "model_state") this.modelState = String(message.state || "unknown");
    this.emit("event", message);
    // "error" is reserved by EventEmitter and throws when it has no listener.
    // Worker error records are ordinary protocol events, not supervisor faults.
    if (message.type === "error") this.emit("worker_error", message);
    else this.emit(message.type, message);
  }

  _protocolFailure(error) {
    if (this.state === "stopped") return;
    this.emit("fatal", error instanceof Error ? error : new ProtocolError(String(error)));
    this.stop({ force: true });
  }

  _onExit(error, exit) {
    if (!this.child) return;
    clearTimeout(this.startTimer);
    clearTimeout(this.shutdownTimer);
    this.child = null;
    this.waitingDrain = false;
    this.writeQueue = [];
    this.queuedBytes = 0;
    const previous = this.state;
    this.state = "stopped";
    this.modelState = "unknown";
    this.stopPromise = null;
    const detail = { error, ...exit, intentional: this.intentionalExit, stderr: this.stderr.toString("utf8") };
    this.emit("exit", detail);
    if (!this.intentionalExit && previous !== "stopped") this.emit("fatal", new ProtocolError("Worker exited unexpectedly", "WORKER_EXITED"));
  }

  stop({ force = false } = {}) {
    if (!this.child) return Promise.resolve();
    if (this.stopPromise) {
      if (force && this.child) this.child.kill();
      return this.stopPromise;
    }
    this.intentionalExit = true;
    this.state = "stopping";
    this.stopPromise = new Promise((resolve) => {
      const done = () => {
        clearTimeout(this.shutdownTimer);
        resolve();
      };
      this.once("exit", done);
      this.shutdownTimer = setTimeout(() => { if (this.child) this.child.kill(); }, this.options.shutdownTimeoutMs);
    });
    if (force) {
      this.child.kill();
      return this.stopPromise;
    }
    try {
      this.send({ type: "shutdown", sequence: ++this.controlSequence });
    } catch {
      if (this.child) this.child.kill();
    }
    return this.stopPromise;
  }
}

module.exports = { DEFAULTS, ProtocolError, LengthPrefixedJsonParser, encodeRecord, WorkerSupervisor };
