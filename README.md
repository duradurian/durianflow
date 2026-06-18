# Whisper Live Backend

`whisper-live` is a local Windows dictation stack. The Python backend exposes a FastAPI HTTP/WebSocket transcription API, runs local inference through `faster-whisper` and CTranslate2, and accepts 16 kHz mono PCM Int16 audio. The Electron desktop client turns that backend into a global hotkey voice keyboard.

This project does not use the hosted OpenAI API. Inference runs on your own machine or server.

## What Remains

- `backend/app/`: FastAPI app, WebSocket handler, session state, VAD, audio validation, model loading, and transcript merging.
- `backend/scripts/`: local utilities for transcribing files, streaming WAV files, and benchmarking models.
- `backend/tests/`: focused unit tests for protocol, audio, merge, and session behavior.
- `desktop/`: Electron tray app that records microphone audio on a global hotkey, optionally refines the transcript with a local llama.cpp or Ollama model, and pastes the result into the focused textbox.
- `protocol.md`: JSON control/transcript events and binary PCM audio frame contract.
- `docs/`: backend setup, API, architecture, GPU, and troubleshooting notes.

## Backend Setup

```bash
cd backend
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload
```

On Windows PowerShell:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
Copy-Item .env.example .env
python -m uvicorn app.main:app --reload --app-dir .
```

The backend also includes Windows launchers that create the venv if needed, install requirements, and start the server:

```powershell
cd C:\Users\Darrien\Desktop\code\Openflow\whisper-live\backend
.\run_backend.ps1
```

If PowerShell script execution is blocked:

```powershell
.\run_backend.bat
```

The default model is `large-v3-turbo` on CUDA with `float16`. For CPU-only machines, set:

```env
DEVICE=cpu
COMPUTE_TYPE=int8
```

Health check:

```bash
curl http://localhost:8000/health
```

List known models:

```bash
curl http://localhost:8000/v1/models
```

Transcribe a file:

```bash
python scripts/transcribe_file.py path/to/audio.wav
```

Stream a WAV file as live PCM:

```bash
python scripts/stream_wav.py path/to/audio.wav --url ws://localhost:8000/v1/transcribe
```

## Client Integration

Clients should connect to:

```text
ws://localhost:8000/v1/transcribe
```

The client must send a JSON `start` message, then binary WebSocket frames containing raw little-endian signed 16-bit PCM, mono, 16 kHz audio. The backend emits status, partial transcript, final transcript, and error events. See `protocol.md` and `docs/backend-api.md`.

## TrueScribe Desktop App

From `desktop/`:

```powershell
npm install
npm start
```

Default flow:

1. Focus a textbox in any Windows app.
2. Press `Ctrl+Alt+Space`.
3. Speak.
4. Press `Ctrl+Alt+Space` again.
5. The app optionally refines the finalized transcript, then pastes the result into the focused textbox.

See `desktop/README.md` for configuration and implementation notes.

TrueScribe includes a tray menu and settings window for recording the hotkey, choosing toggle or hold-to-speak behavior, choosing a microphone and language, switching between fast and accurate mode, and paste behavior. Backend URLs and optional local LLM writing assistance live in a separate Advanced settings window.

## NVIDIA GPU Docker

```bash
cp backend/.env.example backend/.env
docker compose up --build backend
```

The Dockerfile is NVIDIA-first and uses a CUDA/cuDNN runtime image. Install NVIDIA Container Toolkit before running Compose. For native Windows Python GPU setup and `cublas64_12.dll` errors, see `docs/nvidia-gpu.md`.

## Known Limitations

- Whisper is not true token streaming; this service uses rolling-window re-transcription for partials.
- VAD is energy-based and intentionally simple. Silero VAD is a good next upgrade.
- Clients are responsible for capture, resampling, and sending valid PCM frames.
- GPU concurrency defaults to one transcription at a time.

## Troubleshooting

See `docs/troubleshooting.md` for backend connectivity, CUDA, model download, latency, silence, and duplicate text issues.
