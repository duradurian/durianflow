"use strict";

const { EventEmitter } = require("events");
const { WorkerSupervisor, ProtocolError } = require("./worker_supervisor");

class LocalWorkerTransport extends EventEmitter {
  constructor(options = {}) {
    super();
    this.supervisor = options.supervisor || new WorkerSupervisor(options);
    this.session = null;
    this.generation = 0;
    this.creditBytes = 0;
    this._bindSupervisor();
  }

  _bindSupervisor() {
    this.supervisor.on("event", (event) => {
      if (event.type === "model_state") this.emit("model", event);
      if (event.sessionId && (!this.session || event.sessionId !== this.session.id || event.generation !== this.generation)) return;
      if (event.type === "accepted") {
        this.creditBytes = Math.max(0, Number(event.creditBytes) || 0);
        if (this.session) this.session.state = "active";
      }
      // Clear terminal state before notifying listeners so a terminal handler
      // can synchronously begin the next session without seeing stale state.
      if (event.type === "stopped" || event.type === "canceled") {
        this.session = null;
        this.creditBytes = 0;
      }
      this.emit("event", event);
      // Protocol error records are forwarded through "event". Emitting them as
      // EventEmitter's reserved "error" channel would misclassify a recoverable
      // session error as a supervisor failure and notify the recorder twice.
      if (event.type !== "error") this.emit(event.type, event);
    });
    this.supervisor.on("backpressure", (state) => this.emit("pressure", { ...state, creditBytes: this.creditBytes }));
    this.supervisor.on("fatal", (error) => this.emit("error", error));
    this.supervisor.on("exit", (detail) => {
      this.session = null;
      this.creditBytes = 0;
      this.emit("exit", detail);
    });
  }

  startWorker() { return this.supervisor.start(); }
  getState() { return { worker: this.supervisor.state, model: this.supervisor.modelState, session: this.session && { ...this.session }, creditBytes: this.creditBytes }; }

  start({ sessionId, sampleRate = 16000, channels = 1, format = "pcm_s16le", language = null, mode = "fast" }) {
    if (this.session) throw new Error("A dictation session is already active");
    if (!sessionId || typeof sessionId !== "string") throw new TypeError("sessionId is required");
    this.generation += 1;
    this.session = { id: sessionId, state: "starting" };
    this.creditBytes = 0;
    try {
      this.supervisor.send({ type: "start", sessionId, generation: this.generation, sequence: 0, sampleRate, channels, format, language, mode });
    } catch (error) {
      this.session = null;
      throw error;
    }
    return { sessionId, generation: this.generation };
  }

  sendAudio(audio) {
    if (!this.session) throw new Error("No active dictation session");
    const bytes = Buffer.isBuffer(audio) ? audio : Buffer.from(audio);
    if (bytes.length === 0 || bytes.length > this.supervisor.options.maxAudioBytes || bytes.length % 2) {
      throw new ProtocolError("Invalid PCM audio frame", "INVALID_AUDIO_FRAME");
    }
    if (bytes.length > this.creditBytes) {
      this.emit("pressure", { creditBytes: this.creditBytes });
      return false;
    }
    this.supervisor.send({ type: "audio", sessionId: this.session.id, generation: this.generation, sequence: (this.session.sequence = (this.session.sequence || 0) + 1), audioBase64: bytes.toString("base64") });
    if (this.creditBytes) this.creditBytes -= bytes.length;
    return true;
  }

  stop() { return this._finish("stop", "stopping"); }
  cancel() { return this._finish("cancel", "canceling"); }
  _finish(type, state) {
    if (!this.session) return false;
    if (this.session.state === state) return true;
    if (this.session.state === "canceling" && type === "stop") return true;
    const previousState = this.session.state;
    const previousSequence = this.session.sequence || 0;
    const sequence = previousSequence + 1;
    this.session.state = state;
    this.session.sequence = sequence;
    try {
      this.supervisor.send({ type, sessionId: this.session.id, generation: this.generation, sequence });
    } catch (error) {
      this.session.state = previousState;
      this.session.sequence = previousSequence;
      throw error;
    }
    return true;
  }
  shutdown(options) {
    this.session = null;
    this.creditBytes = 0;
    return this.supervisor.stop(options);
  }
}

module.exports = { LocalWorkerTransport };
