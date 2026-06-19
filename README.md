# Openflow

Note: App is in very early stages and has known issues. Treat it like a prototype.

Openflow is a local Windows dictation app that turns speech into text in any focused textbox. It combines an Electron tray client with a FastAPI transcription backend powered by `faster-whisper` and CTranslate2.

Openflow does not use the hosted OpenAI API. Speech recognition runs on your own machine or server.

## Features

- Global hotkey dictation with toggle or hold-to-speak behavior.
- Automatic paste into the focused Windows app.
- Local `faster-whisper` transcription over a FastAPI WebSocket backend.
- Tray settings for hotkey, microphone, language, fast or accurate mode, paste behavior, and backend status.
- Optional local writing assistance through `llama.cpp` or Ollama.
- CPU mode for broad compatibility and CUDA mode for NVIDIA GPU acceleration.
- Backend HTTP/WebSocket API for custom clients.

## Repository Layout

```text
backend/              FastAPI app, transcription sessions, VAD, model loading, and tests
backend/scripts/      File transcription, WAV streaming, and benchmark utilities
desktop/              Electron tray app for Windows dictation and paste automation
docs/                 Architecture, setup, backend API, GPU, and troubleshooting notes
protocol.md           WebSocket message and PCM audio contract
docker-compose.yml    NVIDIA GPU backend deployment helper
```

## Requirements

- Windows 10 or newer for the desktop app.
- Python 3.11 for the backend.
- Node.js and npm for the Electron client.
- A working microphone.
- Optional: NVIDIA GPU with CUDA/cuDNN for GPU inference.
- Optional: Docker with NVIDIA Container Toolkit for GPU container deployment.

## Quick Start

The easiest Windows flow is to start the Electron app. It will try to start the backend automatically.

```powershell
cd desktop
npm install
npm start
```

Then:

1. Focus a textbox in any Windows application.
2. Press `Ctrl+Alt+Space`.
3. Speak.
4. Press `Ctrl+Alt+Space` again, or release it if hold mode is enabled.
5. Openflow pastes the finalized transcript into the focused textbox.

Before the first transcription, Openflow can download and cache the configured Whisper model automatically. To preinstall it explicitly:

```powershell
cd backend
python scripts/install_model.py large-v3-turbo
```

If `ALLOW_MODEL_DOWNLOAD=false` is set and the model is missing, `/health` reports the setup error instead of downloading.

If PowerShell blocks `npm.ps1`, use the command shim:

```powershell
npm.cmd install
npm.cmd start
```

## Backend Setup

The backend can be started manually from `backend/`.

### Windows Launcher

```powershell
cd backend
.\run_backend.ps1
```

The launcher creates `.venv` with Python 3.11 if needed, installs `requirements.txt` and `requirements-gpu-windows.txt` only during setup, then starts the backend on `127.0.0.1:8000`.

If script execution is blocked:

```powershell
cd backend
.\run_backend.bat
```

### Manual Setup

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
Copy-Item .env.example .env
python scripts/install_model.py large-v3-turbo
python scripts/run_server.py
```

For CPU-only machines, edit `backend/.env`:

```env
DEVICE=cpu
COMPUTE_TYPE=int8
```

For native Windows GPU inference, install the CUDA/cuDNN dependencies described in [docs/nvidia-gpu.md](docs/nvidia-gpu.md), then keep:

```env
DEVICE=cuda
COMPUTE_TYPE=float16
```

## Desktop App

Run the desktop client from `desktop/`:

```powershell
cd desktop
npm install
npm start
```

The app includes:

- Tray menu and status window.
- Main settings for hotkey, input behavior, microphone, language, transcription mode, and paste behavior.
- Advanced settings for backend URLs, automatic backend startup, and optional local LLM refinement.

Default desktop endpoints:

```text
Backend WebSocket: ws://127.0.0.1:8000/v1/transcribe
Health check:      http://127.0.0.1:8000/health
```

See [desktop/README.md](desktop/README.md) for the full desktop configuration reference.

## Backend API

Openflow exposes:

```text
GET /health
GET /v1/models
WS  /v1/transcribe
```

Health check:

```powershell
curl http://127.0.0.1:8000/health
```

List known models:

```powershell
curl http://127.0.0.1:8000/v1/models
```

WebSocket clients connect to:

```text
ws://127.0.0.1:8000/v1/transcribe
```

The client sends a JSON `start` message, then binary little-endian signed 16-bit PCM audio: mono, 16 kHz. The backend emits `ready`, status, partial transcript, final transcript, and error events.

See [protocol.md](protocol.md) and [docs/backend-api.md](docs/backend-api.md) for the full API contract.

## Backend Utilities

Transcribe an audio file:

```powershell
cd backend
python scripts/transcribe_file.py path\to\audio.wav
```

Stream a WAV file through the live WebSocket path:

```powershell
cd backend
python scripts/stream_wav.py path\to\audio.wav --url ws://127.0.0.1:8000/v1/transcribe
```

Benchmark models:

```powershell
cd backend
python scripts/benchmark_models.py
```

## Configuration

Backend settings are loaded from `backend/.env`. Important defaults:

```env
MODEL_NAME=large-v3-turbo
MODELS_DIR=./models
MODEL_PATH=
ALLOW_MODEL_DOWNLOAD=true
HOST=127.0.0.1
OPENFLOW_SERVER_MODE=false
DEVICE=cuda
COMPUTE_TYPE=float16
LANGUAGE=en
SAMPLE_RATE=16000
CHANNELS=1
PARTIAL_INTERVAL_MS=1000
ROLLING_WINDOW_SECONDS=6
MAX_CONCURRENT_TRANSCRIPTIONS=1
REQUIRE_API_TOKEN=false
API_TOKEN=
```

Set `OPENFLOW_SERVER_MODE=true`, `REQUIRE_API_TOKEN=true`, and `API_TOKEN=...` only when intentionally exposing the backend outside local desktop mode.
For fully offline startup, preinstall a model with `scripts/install_model.py` and set `ALLOW_MODEL_DOWNLOAD=false`.
For remote browser clients, also set `ALLOWED_ORIGINS` to the exact client origins that may open the WebSocket.

## Local LLM Refinement

The desktop app can optionally refine finalized transcripts before paste using a local `llama.cpp` OpenAI-compatible chat completions endpoint or an Ollama server.

Supported refinement modes are:

- `grammar`: clean up grammar and punctuation.
- `format`: format dictated text for readability.
- `enhance`: lightly improve phrasing.

If the LLM server is unavailable or too slow, Openflow inserts the original transcript.

## Docker

The included Docker setup is NVIDIA-first and runs only the backend.

```powershell
Copy-Item backend\.env.example backend\.env
cd backend
python scripts\install_model.py --models-dir .\models
cd ..
$env:API_TOKEN="replace-with-a-long-random-token"
docker compose up --build backend
```

Compose builds `backend/Dockerfile`, publishes port 8000 on `127.0.0.1` only, requires `API_TOKEN`, requests `gpus: all`, and mounts `backend/models` at `/app/models`. Install NVIDIA Container Toolkit before using this path.

## Development Checks

Run backend tests:

```powershell
cd backend
pytest
```

Run the desktop JavaScript syntax check:

```powershell
cd desktop
npm run check
```

## Documentation

- [docs/local-setup.md](docs/local-setup.md): local backend and desktop setup.
- [docs/backend-api.md](docs/backend-api.md): HTTP and WebSocket API details.
- [docs/architecture.md](docs/architecture.md): backend and desktop flow diagrams.
- [docs/nvidia-gpu.md](docs/nvidia-gpu.md): NVIDIA GPU setup and CUDA troubleshooting.
- [docs/troubleshooting.md](docs/troubleshooting.md): common startup, model, latency, and transcription issues.

## Known Limitations

- Whisper is not true token streaming; Openflow uses rolling-window re-transcription for partial results.
- VAD is energy-based and intentionally simple.
- Clients are responsible for microphone capture, resampling, and valid PCM frames.
- GPU concurrency defaults to one transcription at a time.
