# Durianflow Project Pipeline

This is the end-to-end map of the desktop dictation path, Python sidecar, model lifecycle, optional local refinement, command-line utilities, and checks. The root documentation calls the product **Durianflow**; several desktop and backend identifiers retain the earlier **Openflow** name.

```mermaid
flowchart TB
  User["User and focused Windows text field"]

  subgraph Provision["Provisioning, configuration, and checks"]
    direction LR
    DesktopStart["desktop: npm start"]
    DesktopConfig["Electron userData/config.json<br/>hotkey, mic, language, mode, paste, LLM"]
    BackendEnv["backend/.env<br/>model, device, VAD, buffers, concurrency"]
    InstallModel["install_model.py<br/>download, validate, atomically install"]
    ModelCache[("MODEL_PATH or models cache<br/>model.bin + config.json")]
    FileCli["transcribe_file.py<br/>read, mono, resample"]
    Benchmark["benchmark_models.py<br/>silent sample + timing"]
    ProtocolDoc["protocol.md"]
    Pytest["pytest backend/tests"]
    NodeCheck["npm run check"]

    InstallModel --> ModelCache
  end

  subgraph Desktop["Electron desktop application"]
    direction TB
    Main["main.js<br/>startup, tray, hotkey, lifecycle, config, output"]
    Trust["Secure BrowserWindows and media policy<br/>sandbox, context isolation, no Node, trusted senders"]
    Ui["Recorder, settings, advanced settings, status<br/>HTML + renderer controllers"]
    Preload["preload.js<br/>fixed window.openflow contextBridge APIs"]
    Recorder["recorder.js<br/>getUserMedia, ScriptProcessor,<br/>downsample to mono 16 kHz PCM16"]
    IpcGate["Main-process IPC validation<br/>recorder-only session/audio, ArrayBuffer and format checks"]
    Transport["dictation_transport.js + local_worker_transport.js<br/>UUID, generation, sequence, credits"]
    Supervisor["worker_supervisor.js<br/>spawn, bounded queues, parser, stderr ring buffer, shutdown"]
    Hotkey["Tray or global hotkey<br/>toggle / hold watcher"]
    Complete["completeDictation<br/>normalize transcript"]
    RefineGate{"Refinement enabled?"}
    TextProcessor["text_processor.js<br/>prompt, timeout, output validation"]
    LocalLlm["llama.cpp or Ollama service<br/>localhost by default; remote opt-in"]
    Clipboard["Clipboard write<br/>preserve copied transcript on failure"]
    Paste["Hidden PowerShell Ctrl+V<br/>when autoPaste is enabled"]
  end

  subgraph Worker["Supervised local Python transcription sidecar"]
    direction TB
    RunWorker["scripts/run_worker.py"]
    Framing["worker_protocol.py<br/>protocol v1, 4-byte length-prefixed UTF-8 JSON,<br/>bounded records and base64 PCM"]
    WorkerLoop["worker.py: TranscriptionWorker<br/>async model load, active session, cancellation, credits"]
    ModelLoad["transcriber.py + cuda_runtime.py<br/>load faster-whisper; CUDA float16 or CPU int8 fallback"]
    ResolveModel{"model_store.py<br/>valid MODEL_PATH / cache / download allowed?"}
    Unavailable["model_state: unavailable"]
    Whisper["faster-whisper / CTranslate2 model"]
    Session["session.py<br/>bounded PCM buffers, session metrics,<br/>rolling partial and final triggers"]
    Pcm["audio.py<br/>PCM16 bytes to float32"]
    Vad["vad.py<br/>energy VAD: speech start/end + trailing pad"]
    Assemble["schemas.py + merge.py<br/>normalize text, de-duplicate overlap,<br/>partial/final/status events"]
  end

  %% Startup, UI, and trust boundary
  DesktopStart --> Main
  DesktopConfig --> Main
  Main --> Trust
  Trust --> Ui
  Trust --> Preload
  Ui <--> Preload
  Main -->|config and status updates| Preload
  User -->|tray action or hotkey| Hotkey
  Hotkey --> Main
  Main -->|dictation:start / stop| Preload
  Preload --> Recorder

  %% Recorder to local worker, with all renderer access brokered by main
  Recorder -->|start request, PCM frames,<br/>stop or cancel| Preload
  Preload -->|fixed IPC only| IpcGate
  IpcGate --> Main
  Main --> Transport
  Transport --> Supervisor
  Main -->|launch configured Python| Supervisor
  Supervisor --> RunWorker --> Framing
  Supervisor -->|hello, start, audio, stop,<br/>cancel, shutdown| Framing
  Framing --> WorkerLoop

  %% Python model startup and inference
  BackendEnv --> WorkerLoop
  BackendEnv --> ModelLoad
  BackendEnv --> ResolveModel
  ModelCache --> ResolveModel
  ResolveModel -->|valid local model| ModelLoad
  ResolveModel -->|missing and downloads allowed| ModelLoad
  ResolveModel -->|missing and downloads disabled| Unavailable
  ModelLoad --> Whisper
  Unavailable --> WorkerLoop
  WorkerLoop -->|accepted ordered PCM| Session
  Session --> Pcm --> Vad
  Vad -->|speech buffer and timing| Session
  Session -->|partial window or final utterance| Whisper
  Whisper -->|segments| Assemble
  Assemble --> WorkerLoop

  %% Worker events return through the same framed stdio contract
  WorkerLoop -->|worker_ready, model_state, accepted, ready,<br/>status, partial, final, stopped, canceled, error| Framing
  Framing --> Supervisor
  Supervisor -->|filter current session/generation| Transport
  Transport --> Main
  Main -->|partial, final, status, error| Preload
  Preload --> Recorder
  Recorder -->|stopped: assembled transcript| Complete

  %% Deliver the completed transcript
  Complete --> RefineGate
  RefineGate -->|no, unavailable, invalid, or late| Clipboard
  RefineGate -->|yes| TextProcessor
  TextProcessor -->|local HTTP by default| LocalLlm
  LocalLlm --> TextProcessor
  TextProcessor -->|refined text or raw fallback| Clipboard
  Clipboard -->|autoPaste| Paste --> User
  Clipboard -->|autoPaste off or paste failure| User

  %% Reusable model paths and non-runtime repository support
  FileCli --> Whisper
  Benchmark --> Whisper
  ProtocolDoc -. documents framing contract .-> Framing
  Pytest -. covers protocol, worker, session, VAD, audio, merge, model paths .-> WorkerLoop
  NodeCheck -. syntax checks desktop source .-> Main
```

The solid arrows are runtime or utility data/control flow. Dashed arrows describe documentation and verification. The worker is local-only: it uses supervised stdio rather than an HTTP listener. Audio and transcript state are held in memory for the active session; durable state is the Electron configuration and the installed model cache.
