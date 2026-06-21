"use strict";

const { EventEmitter } = require("events");
const { WorkerSupervisor, ProtocolError } = require("./worker_supervisor");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
      if (event.type === "accepted") this.creditBytes = Math.max(0, Number(event.creditBytes) || 0);
      if (event.type === "model_state") this.emit("model", event);
      if (event.sessionId && (!this.session || event.sessionId !== this.session.id || event.generation !== this.generation)) return;
      if (event.type === "ready" && this.session?.state === "starting") this.session.state = "recording";
      this.emit("event", event);
      this.emit(event.type, event);
      // The terminal event still belongs to the just-finished session, but a
      // subsequent start must not be blocked by stale local state.
      if (event.type === "stopped" || event.type === "canceled" || (event.type === "status" && event.status === "stopped")) {
        this.session = null;
        this.creditBytes = 0;
      }
    });
    this.supervisor.on("backpressure", (state) => this.emit("pressure", { ...state, creditBytes: this.creditBytes }));
    this.supervisor.on("fatal", (error) => this.emit("error", error));
    this.supervisor.on("exit", (detail) => { this.session = null; this.emit("exit", detail); });
  }

  startWorker() { return this.supervisor.start(); }
  getState() { return { worker: this.supervisor.state, model: this.supervisor.modelState, session: this.session && { ...this.session }, creditBytes: this.creditBytes }; }

  start({ sessionId, sampleRate = 16000, channels = 1, format = "pcm_s16le", language = null, mode = "fast" }) {
    if (this.session) throw new Error("A dictation session is already active");
    if (!UUID_PATTERN.test(sessionId || "")) throw new ProtocolError("sessionId must be a UUID", "INVALID_SESSION_ID");
    this.generation += 1;
    this.session = { id: sessionId, state: "starting" };
    this.creditBytes = 0;
    this.supervisor.send({ type: "start", sessionId, generation: this.generation, sequence: 0, sampleRate, channels, format, language, mode });
    return { sessionId, generation: this.generation };
  }

  sendAudio(audio) {
    if (!this.session) throw new Error("No active dictation session");
    if (!["starting", "recording"].includes(this.session.state)) {
      throw new ProtocolError("Dictation session is not accepting audio", "INVALID_SESSION_STATE");
    }
    if (!Buffer.isBuffer(audio)) throw new TypeError("Audio must be a Buffer");
    const bytes = audio;
    if (bytes.length === 0 || bytes.length > this.supervisor.options.maxAudioBytes || bytes.length % 2) {
      throw new ProtocolError("Invalid PCM audio frame", "INVALID_AUDIO_FRAME");
    }
    if (this.creditBytes && bytes.length > this.creditBytes) {
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
    if (this.session.state === "canceling" || this.session.state === "stopping") return false;
    this.session.state = state;
    this.supervisor.send({ type, sessionId: this.session.id, generation: this.generation, sequence: (this.session.sequence || 0) + 1 });
    return true;
  }
  shutdown(options = {}) { this.session = null; return this.supervisor.stop(options); }
}

module.exports = { LocalWorkerTransport };
