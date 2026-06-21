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

The desktop app resolves `backend/.venv/Scripts/python.exe` by default. Set `OPENFLOW_PYTHON` to an explicit interpreter path only when that default is unsuitable.

Press `Ctrl+Alt+Space` to start dictation, then press it again to stop, finalize, and paste the transcript into the focused textbox.

## Model and device configuration

With `ALLOW_MODEL_DOWNLOAD=true`, worker startup can download/cache the selected model. For offline startup, install a model explicitly with `scripts/install_model.py`, or set `MODEL_PATH` and set `ALLOW_MODEL_DOWNLOAD=false`.

CPU configuration in `backend/.env`:

```env
DEVICE=cpu
COMPUTE_TYPE=int8
```

NVIDIA configuration:

```env
DEVICE=cuda
COMPUTE_TYPE=float16
```

See [nvidia-gpu.md](nvidia-gpu.md) for native Windows GPU setup.

Then open `http://127.0.0.1:8000/health`. This server is separate from the default desktop worker path; see [backend-api.md](backend-api.md).
