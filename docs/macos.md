# macOS

## Supported configuration

- Apple Silicon Mac.
- macOS 14 or newer for current MLX wheels.
- Native arm64 Python 3.11 or newer.
- Toggle-mode global shortcut.

Verify the interpreter architecture:

```bash
python3 -c 'import platform; print(platform.machine())'
```

It should print `arm64`. If it prints `x86_64`, install a native Python and recreate `backend/.venv`.

## Setup

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

The Electron launcher checks `backend/.venv/bin/python`, then `python3`. Override it with `DURIANFLOW_PYTHON=/absolute/path/to/python` when needed.

## Permissions

Allow microphone access when macOS prompts. For automatic insertion, open **System Settings → Privacy & Security → Accessibility** and enable Durianflow. Also open **Privacy & Security → Automation** and allow Durianflow to control System Events. During source development, macOS may list Terminal, Electron, or `osascript` instead of Durianflow.

At dictation start Durianflow captures the frontmost process and Core Graphics window number. Immediately before insertion, one JXA process revalidates both values and sends Command-V. If focus changed, permission was denied, or completion is ambiguous, Durianflow does not retry; the transcript remains on the clipboard.

## Unified memory

MLX uses Apple unified memory. The settings resource card therefore reports combined Electron/worker memory against system memory instead of invoking `nvidia-smi`.

## Packaging note

The runtime can resolve packaged backend resources from `Contents/Resources/backend` and stores managed models in the Electron user-data directory. The repository intentionally does not advertise a production package target: a distributable `.app` must first include an arm64 Python runtime and installed backend dependencies, plus microphone and Apple Events usage descriptions, signing, hardened-runtime entitlements, and notarization. The source checkout does not vendor a Python distribution.
