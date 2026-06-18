# Architecture

Whisper Live is a local dictation stack. The backend owns API validation, transcription sessions, VAD, faster-whisper inference, and transcript event generation. The desktop client owns the Windows hotkey, microphone capture, and text insertion.

## Components

- FastAPI app: exposes `/health`, `/v1/models`, and `/v1/transcribe`.
- WebSocket handler: validates control messages, accepts PCM audio frames, and returns JSON events.
- Session: manages rolling buffers, VAD state, partial/final triggers, and duplicate cleanup.
- Transcriber: owns faster-whisper model loading and inference.
- Scripts: provide local file transcription, WAV streaming, and model benchmarking.
- Electron main process: registers the global hotkey, starts the backend, manages the tray menu, optionally refines finalized text with llama.cpp or Ollama, and pastes text into the focused app.
- Electron recorder renderer: captures microphone audio, converts it to `pcm_s16le` mono 16 kHz, and streams it to the backend WebSocket.

## Live Transcription Flow

```mermaid
sequenceDiagram
  participant Client
  participant Socket
  participant Session
  participant VAD
  participant Model
  Client->>Socket: start JSON
  Socket->>Session: create session
  Socket->>Client: ready
  loop audio frames
    Client->>Socket: binary PCM
    Socket->>Session: accept_pcm16
    Session->>VAD: process frame
    alt active speech and partial interval elapsed
      Session->>Model: transcribe rolling window
      Session->>Client: partial
    end
    alt silence threshold reached
      Session->>Model: transcribe speech buffer
      Session->>Client: final
    end
  end
  Client->>Socket: stop
  Socket->>Session: finalize active speech
  Socket->>Client: stopped
```

## Desktop Dictation Flow

```mermaid
sequenceDiagram
  participant User
  participant Main as Electron Main
  participant Recorder as Hidden Recorder
  participant Backend
  participant Target as Focused Textbox
  User->>Target: focus textbox
  User->>Main: press global hotkey
  Main->>Recorder: start dictation
  Recorder->>Backend: start JSON
  loop microphone frames
    Recorder->>Backend: binary PCM
  end
  User->>Main: press global hotkey
  Main->>Recorder: stop dictation
  Recorder->>Backend: stop JSON
  Backend->>Recorder: final transcript
  Recorder->>Main: transcript text
  Main->>Main: optional text refinement
  Main->>Target: paste transcript
```
