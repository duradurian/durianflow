# Durianflow

Durianflow is a private, local dictation app for macOS and Windows. An Electron tray client captures microphone audio and streams it to a supervised Python worker; speech recognition stays on the computer.

The worker automatically chooses the best available inference backend:

1. **Apple MLX + Metal** on supported Apple Silicon Macs.
2. **NVIDIA CUDA** when CTranslate2 detects a compatible GPU.
3. **CPU int8** everywhere `faster-whisper` is available.

The backend can also be pinned to MLX, CUDA, or CPU in Advanced Settings. Explicit choices fail with an actionable status when unavailable; Automatic mode is allowed to fall through to the next usable engine.

## Features

- Global hotkey dictation with toggle behavior on macOS and Windows.
- Focus-validated paste into the original macOS or Windows application.
- Native Apple Silicon inference through `mlx-whisper` and Metal.
- CUDA and CPU inference through `faster-whisper` and CTranslate2.
- Engine-specific, managed model downloads; incompatible MLX and CTranslate2 weights never share a slot.
- Tray settings for microphone, language, fast/accurate model profiles, paste behavior, and live backend status.
- Optional local writing assistance through llama.cpp or Ollama.
- No hosted speech-recognition API.

## Requirements

- Python 3.11 or newer and Node.js 22.12+/npm for the current Electron toolchain.
- macOS 14+ on Apple Silicon for MLX/Metal.
- Windows 10+ for the Windows desktop path.
- A working microphone.
- Optional: NVIDIA GPU plus CUDA/cuDNN for CUDA inference.

MLX must run under a native arm64 Python process, not an x86 Python process under Rosetta.

## Quick start

### macOS / Linux shell

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
cp .env.example .env

cd ../desktop
npm install
npm start
```

On Apple Silicon, `requirements.txt` installs `mlx-whisper` automatically. The default `DEVICE=auto` selects MLX when Metal is usable, otherwise CUDA, otherwise CPU. The selected model is downloaded on first use unless downloads are disabled.

### Windows PowerShell

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
Copy-Item .env.example .env

cd ..\desktop
npm install
npm start
```

The desktop resolves `.venv/bin/python` on POSIX and `.venv/Scripts/python.exe` on Windows. `DURIANFLOW_PYTHON` can override the interpreter.

## macOS permissions

Durianflow needs:

- **Microphone** access to capture speech.
- **Accessibility** access to send Command-V after revalidating the application and window that were focused when dictation began.
- **Automation** access to let the paste helper control System Events.

If either paste permission is denied, the transcript remains on the clipboard and the status window shows the relevant System Settings location. See [docs/macos.md](docs/macos.md).

## Backend configuration

Desktop settings are authoritative for the worker it launches. Directly launched scripts use `backend/.env`:

```env
MODEL_NAME=large-v3-turbo
MODELS_DIR=./models
MODEL_PATH=
MLX_MODEL_PATH=
ALLOW_MODEL_DOWNLOAD=true
DEVICE=auto
COMPUTE_TYPE=auto
LANGUAGE=en
```

Supported `DEVICE` values are `auto`, `mlx`, `cuda`, and `cpu`. Automatic selection uses MLX → CUDA → CPU priority. MLX uses float16 Metal inference, CUDA uses float16, and CPU uses int8 by default.

To preinstall the best model format for the current machine:

```bash
cd backend
python scripts/install_model.py large-v3-turbo --backend auto
```

Or select a format explicitly:

```bash
python scripts/install_model.py large-v3-turbo --backend mlx
python scripts/install_model.py large-v3-turbo --backend cuda
python scripts/install_model.py large-v3-turbo --backend cpu
```

MLX slots use names such as `models/mlx--large-v3-turbo`; CTranslate2 retains its own model layout. See [docs/compute-backends.md](docs/compute-backends.md).

## Utilities

```bash
cd backend
python scripts/transcribe_file.py path/to/audio.wav --backend auto
python scripts/benchmark_models.py --backend auto
python scripts/manage_model.py status --model large-v3-turbo --backend auto --json
python scripts/detect_backends.py
```

## Repository layout

```text
backend/app/          Runtime selection, model adapters, worker, sessions, VAD, and audio
backend/scripts/      Worker, model management, file transcription, and benchmarks
backend/tests/        Hardware-independent backend tests
desktop/src/          Electron main/renderer code and Windows/macOS integration
desktop/test/         Desktop transport, safety, and platform tests
docs/                 Architecture, setup, backend, GPU, macOS, and troubleshooting guides
protocol.md           Local worker framing and PCM contract
```

## Development checks

```bash
cd backend
pytest

cd ../desktop
npm run check
npm test
```

## Documentation

- [Local setup](docs/local-setup.md)
- [Compute backends](docs/compute-backends.md)
- [macOS integration](docs/macos.md)
- [NVIDIA GPU setup](docs/nvidia-gpu.md)
- [Architecture](docs/architecture.md)
- [Troubleshooting](docs/troubleshooting.md)

## Known limitations

- Whisper is not true token streaming; the hidden desktop recorder performs final utterance transcription for the shortest stop-to-paste path.
- Hold-to-speak key-up monitoring remains Windows-only; toggle mode is cross-platform.
- Linux uses the same worker and Electron capture path, but automatic cross-application paste is currently clipboard-only.
- A distributable app still needs an architecture-matched Python runtime and dependencies included beside the Electron resources; source development uses `backend/.venv`.
