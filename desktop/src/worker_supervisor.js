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
    this.intentionalExit = false;
    this.controlSequence = 0;
  }

  start() {
    if (this.child) return Promise.reject(new Error("Worker is already running"));
    this.state = "starting";
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
      const cleanup = () => { this.off("ready", ready); this.off("fatal", failed); };
      this.once("ready", ready);
      this.once("fatal", failed);
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
      this.state = "ready";
      this.emit("ready", message);
    }
    if (message.type === "model_state") this.modelState = String(message.state || "unknown");
    this.emit("event", message);
    this.emit(message.type, message);
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
    // stderr can contain model paths or exception data.  Keep only structural
    // diagnostics on the public supervisor event.
    const detail = { error: error ? new ProtocolError("Worker process error", "WORKER_PROCESS_ERROR") : null, ...exit, intentional: this.intentionalExit, stderrBytes: this.stderr.length };
    this.emit("exit", detail);
    if (!this.intentionalExit && previous !== "stopped") this.emit("fatal", new ProtocolError("Worker exited unexpectedly", "WORKER_EXITED"));
  }

  stop({ force = false } = {}) {
    if (!this.child) return Promise.resolve();
    this.intentionalExit = true;
    if (force) {
      this._killProcessTree();
      return Promise.resolve();
    }
    this.state = "stopping";
    try { this.send({ type: "shutdown", sequence: ++this.controlSequence }); } catch { this._killProcessTree(); return Promise.resolve(); }
    return new Promise((resolve) => {
      const done = () => { clearTimeout(this.shutdownTimer); resolve(); };
      this.once("exit", done);
      this.once("shutdown_ack", () => {
        if (this.child) this._killProcessTree();
      });
      this.shutdownTimer = setTimeout(() => { if (this.child) this._killProcessTree(); }, this.options.shutdownTimeoutMs);
    });
  }

  _killProcessTree() {
    const child = this.child;
    if (!child) return;
    if (process.platform === "win32" && Number.isInteger(child.pid)) {
      try {
        const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.on("error", () => { try { child.kill(); } catch {} });
        return;
      } catch {}
    }
    try { child.kill(); } catch {}
  }
}

module.exports = { DEFAULTS, ProtocolError, LengthPrefixedJsonParser, encodeRecord, WorkerSupervisor };
