# Repository Flow

Durianflow is a local Electron dictation application. Electron owns user-facing
state and the Python worker owns transcription; the worker exposes no network
listener.

```mermaid
flowchart LR
  User[User in focused Windows app] -->|hotkey| Main[Electron main\nmain-owned session controller]
  Main --> Windows[Recorder, settings, status windows]
  Windows --> Preload[preload.js fixed contextBridge]
  Preload --> Recorder[recorder.js microphone capture\nmono PCM16 16 kHz]
  Recorder -->|validated IPC| Main
  Main --> Transport[local_worker_transport.js\nsession generation and credits]
  Transport --> Supervisor[worker_supervisor.js\nbounded framed stdio]
  Supervisor --> RunWorker[Fixed packaged Python sidecar\nbackend/scripts/run_worker.py]
  RunWorker --> Worker[app/worker.py]
  Worker --> Session[session.py PCM conversion and buffers]
  Session --> VAD[vad.py energy VAD]
  VAD --> Inference[transcriber.py faster-whisper]
  OfficialMetadata[Release-controlled model metadata] --> Model[model_store.py and cuda_runtime.py]
  CustomConfig[User configuration\ncustom models disabled by default] -. contained custom root .-> Model
  Inference --> Model
  Worker -->|status, partial, final| Supervisor
  Supervisor --> Main
  Main --> Refine[text_processor.js optional local LLM]
  Refine --> Paste[Clipboard; target recheck\nbefore opt-in Ctrl+V]
  Paste --> User

  Install[install_model.py] --> Model
  File[transcribe_file.py] --> Inference
  Benchmark[benchmark_models.py] --> Inference
  Tests[pytest and npm run check] -.-> Worker
```

`worker_protocol.py` defines the length-prefixed JSON records, validates
commands, and bounds audio before decode. `protocol.md` documents that local
worker contract. Electron main, rather than any renderer, owns session state,
worker final-result acceptance, and clipboard completion. A session that is
cancelled, failed, or superseded cannot return to an accepting state.

The model boundary separates release-controlled official artifacts from
user-managed custom models. Official metadata must be packaged with the
release and verified before activation. A custom model is accepted only when a
locally configured opt-in root contains it; it is not an official, trusted
artifact merely because it can be loaded.
