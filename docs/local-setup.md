# Local Setup

## Desktop development path

The desktop application starts a local Python worker directly; it does not use a network service or port 8000.

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
Copy-Item .env.example .env
python scripts/install_model.py large-v3-turbo

cd ..\desktop
npm install
npm start
```

The desktop app resolves `backend/.venv/Scripts/python.exe` by default. Set `DURIANFLOW_PYTHON` to an explicit interpreter path only when that default is unsuitable. `OPENFLOW_PYTHON` remains a compatibility alias.

Press `Ctrl+Alt+Space` to start dictation, then press it again to stop, finalize, and paste the transcript into the focused textbox.

## Model and device configuration

With `ALLOW_MODEL_DOWNLOAD=true`, worker startup can download/cache the selected model. For offline startup, install a model explicitly with `scripts/install_model.py`, or set `MODEL_PATH` and set `ALLOW_MODEL_DOWNLOAD=false`.

The Electron desktop owns its worker's model, device, compute type, and CUDA fallback policy. It defaults to **CPU**; choose **NVIDIA GPU (CUDA)** in **Advanced Settings > Speech Model** after installing its runtime dependencies. The following `.env` settings apply when launching `scripts/run_worker.py` or backend utilities directly.

Direct-worker CPU configuration in `backend/.env`:

```env
DEVICE=cpu
COMPUTE_TYPE=int8
```

Direct-worker NVIDIA configuration:

```env
DEVICE=cuda
COMPUTE_TYPE=float16
```

See [nvidia-gpu.md](nvidia-gpu.md) for native Windows GPU setup.
