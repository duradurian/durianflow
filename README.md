# Durianflow

Note: The app was built for my side quests where he realized I didn't want to use the crappy stock dictation in Windows nor did he want to pay for one of those expensive services so he made his own. As a result, I ended up creating this in 2 hours, and have been working on hardening it so that it is a secure dictation software. There is still a long way to go to harden the app to make it production ready, but it's getting there.


Durianflow is a local Windows dictation app that turns speech into text in any focused textbox. It combines an Electron tray client with a supervised local Python transcription worker powered by `faster-whisper` and CTranslate2.

Durianflow does not use the hosted OpenAI API. Speech recognition runs on your own machine or server. 

## Features

- Global hotkey dictation with toggle or hold-to-speak behavior.
- Copy-to-clipboard completion by default, with opt-in automatic paste when
  the original foreground target can be revalidated.
- Local `faster-whisper` transcription through a supervised stdio worker.
- Tray settings for hotkey, microphone, language, fast or accurate mode, paste behavior, and backend status.
- Optional local writing assistance through `llama.cpp` or Ollama.
- CPU mode for broad compatibility and CUDA mode for NVIDIA GPU acceleration.

## Repository Layout

```text
backend/              Worker, transcription sessions, VAD, model loading, and tests
backend/scripts/      Worker, file transcription, model installation, and benchmark utilities
desktop/              Electron tray app for Windows dictation and paste automation
docs/                 Architecture, setup, GPU, and troubleshooting notes
protocol.md           Local worker framing and PCM audio contract
```

## Requirements

- Windows 10 or newer for the desktop app.
- Python 3.11 for the backend.
- Node.js and npm for the Electron client.
- A working microphone.
- Optional: NVIDIA GPU with CUDA/cuDNN for GPU inference.

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
5. Durianflow copies the finalized transcript. If you explicitly enable
   automatic paste, it pastes only when it can still verify the intended
   foreground target; otherwise the text remains on the clipboard for you to
   paste manually.

Packaged releases do not download models at runtime. Install approved models
explicitly during setup or through the release-approved model installation
flow:

```powershell
cd backend
python scripts/install_model.py large-v3-turbo
```

If `ALLOW_MODEL_DOWNLOAD=false` is set and the model is missing, worker setup
fails without downloading a model.

If PowerShell blocks `npm.ps1`, use the command shim:

```powershell
npm.cmd install
npm.cmd start
```

## Worker Setup

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
Copy-Item .env.example .env
python scripts/install_model.py large-v3-turbo
python scripts/run_worker.py
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

See [desktop/README.md](desktop/README.md) for the full desktop configuration reference.

## Backend Utilities

Transcribe an audio file:

```powershell
cd backend
python scripts/transcribe_file.py path\to\audio.wav
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
# MODEL_PATH is intentionally unsupported; leave it unset.
ALLOW_MODEL_DOWNLOAD=false
CUSTOM_MODELS_DIR=
CUSTOM_MODEL_CONFIG_PATH=
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

For fully offline startup, preinstall a model with `scripts/install_model.py` and set `ALLOW_MODEL_DOWNLOAD=false`.

## Security and privacy

Durianflow processes dictation locally, but that does not protect against
malware, a compromised Windows account, an administrator, or an unlocked PC.
Audio and transcript data are held in memory during an active dictation, and
the final text is placed on the clipboard. Treat the clipboard as sensitive:
other applications running under your account may be able to access it.

Automatic paste is opt-in. Durianflow captures the intended target before
recording and falls back to clipboard-only completion if it cannot revalidate
that target. Review text manually before pasting it into privileged terminals,
password fields, chat applications, or remote sessions.

Official models are release-controlled and integrity-checked. Custom models,
when enabled through the local configuration file, are user-managed and do not
have the same provenance guarantees. Anyone able to edit that file can change
the custom-model policy.

The backend custom-model contract is documented in
[docs/model-security.md](docs/model-security.md). It is disabled by default and
is not a renderer setting.

See [SECURITY.md](SECURITY.md) for vulnerability reporting and
[docs/release-checklist.md](docs/release-checklist.md) for the Windows release
requirements.

## Local LLM Refinement

The desktop app can optionally refine finalized transcripts before paste using a local `llama.cpp` OpenAI-compatible chat completions endpoint or an Ollama server.

Supported refinement modes are:

- `grammar`: clean up grammar and punctuation.
- `format`: format dictated text for readability.
- `enhance`: lightly improve phrasing.

If the LLM server is unavailable or too slow, Durianflow inserts the original transcript.

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
- [docs/architecture.md](docs/architecture.md): backend and desktop flow diagrams.
- [docs/nvidia-gpu.md](docs/nvidia-gpu.md): NVIDIA GPU setup and CUDA troubleshooting.
- [docs/troubleshooting.md](docs/troubleshooting.md): common startup, model, latency, and transcription issues.
- [docs/release-checklist.md](docs/release-checklist.md): signed Windows-release and offline-smoke requirements.
- [docs/model-security.md](docs/model-security.md): official-model provenance and custom-model configuration policy.

## Known Limitations

- Whisper is not true token streaming; Durianflow uses rolling-window re-transcription for partial results.
- VAD is energy-based and intentionally simple.
- Clients are responsible for microphone capture, resampling, and valid PCM frames.
- GPU concurrency defaults to one transcription at a time.
