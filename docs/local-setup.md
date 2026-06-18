# Local Setup

## Backend

```bash
cd backend
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

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

Run:

```bash
uvicorn app.main:app --reload
```

Open `http://localhost:8000/health`.

## First Run

The first backend startup can be slow because CTranslate2/faster-whisper may download model files into the cache volume or user cache directory.

## Desktop Client

From the repository root, install the Electron app dependencies, then start Electron:

```powershell
cd desktop
npm install
npm start
```

`npm install` is only needed the first time, or after the desktop dependencies change.

If PowerShell reports that `npm.ps1` cannot be loaded because script execution is disabled, use the Windows command shim:

```powershell
npm.cmd install
npm.cmd start
```

The desktop app tries to start the backend automatically. If that does not work, start the backend in a separate PowerShell window:

```powershell
cd backend
.\run_backend.ps1
```

If PowerShell script execution is blocked, run:

```powershell
.\run_backend.bat
```

Then run `npm start` again from `desktop/`.

The desktop app registers `Ctrl+Alt+Space` by default. Press once to start microphone dictation, then press again to stop and paste the transcript into the focused textbox.
