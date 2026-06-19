# Local Setup

## Backend

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

Open `http://127.0.0.1:8000/health`.

Normal local backend startup can download and cache the configured model when `ALLOW_MODEL_DOWNLOAD=true`. For fully offline startup, install models explicitly with `scripts/install_model.py`, or set `MODEL_PATH` in `.env` to an existing faster-whisper model directory and set `ALLOW_MODEL_DOWNLOAD=false`.

For CPU machines edit `.env`:

```env
DEVICE=cpu
COMPUTE_TYPE=int8
```

For NVIDIA GPU mode, keep:

```env
DEVICE=cuda
COMPUTE_TYPE=float16
```

On native Windows Python, CUDA Toolkit 12.x and cuDNN for CUDA 12.x must be installed and visible on `PATH`. See `nvidia-gpu.md`.

## Windows Launcher

```powershell
cd backend
.\run_backend.ps1
```

The launcher installs dependencies only when it creates the venv, or when you run:

```powershell
.\run_backend.ps1 -Setup
```

If PowerShell script execution is blocked, run:

```powershell
.\run_backend.bat --setup
```

## Desktop Client

From the repository root:

```powershell
cd desktop
npm install
npm start
```

The desktop app connects to `ws://127.0.0.1:8000/v1/transcribe` by default and rejects remote backend URLs unless the Advanced setting `Allow remote backend URLs` is enabled.

The desktop app registers `Ctrl+Alt+Space` by default. Press once to start microphone dictation, then press again to stop and paste the transcript into the focused textbox.
