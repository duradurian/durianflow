# Repository Flow

Openflow is a local Electron dictation application. Electron owns user-facing
state and the Python worker owns transcription; the worker exposes no network
listener.

```mermaid
flowchart LR
  User[User in focused Windows app] -->|hotkey| Main[Electron main.js]
  Main --> Windows[Recorder, settings, status windows]
  Windows --> Preload[preload.js fixed contextBridge]
  Preload --> Recorder[recorder.js microphone capture\nmono PCM16 16 kHz]
  Recorder -->|validated IPC| Main
  Main --> Transport[local_worker_transport.js\nsession generation and credits]
  Transport --> Supervisor[worker_supervisor.js\nbounded framed stdio]
  Supervisor --> RunWorker[backend/scripts/run_worker.py]
  RunWorker --> Worker[app/worker.py]
  Worker --> Session[session.py PCM conversion and buffers]
  Session --> VAD[vad.py energy VAD]
  VAD --> Inference[transcriber.py faster-whisper]
  Inference --> Model[model_store.py and cuda_runtime.py]
  Worker -->|status, partial, final| Supervisor
  Supervisor --> Main
  Main --> Refine[text_processor.js optional local LLM]
  Refine --> Paste[Clipboard and Ctrl+V]
  Paste --> User

  Install[install_model.py] --> Model
  File[transcribe_file.py] --> Inference
  Benchmark[benchmark_models.py] --> Inference
  Tests[pytest and npm run check] -.-> Worker
```

`worker_protocol.py` defines the length-prefixed JSON records, validates
commands, and bounds audio before decode. `protocol.md` documents that local
worker contract.
