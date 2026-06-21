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

The desktop app resolves `backend/.venv/Scripts/python.exe` by default. Set `DURIANFLOW_PYTHON` to an explicit interpreter path only when that default is unsuitable.

Press `Ctrl+Alt+Space` to start dictation, then press it again to stop, finalize, and paste the transcript into the focused textbox.

## Model and device configuration

Worker startup never downloads a model. `MODEL_PATH` overrides are rejected so
the worker cannot be redirected to an arbitrary local directory. Install the
release-approved model explicitly before starting the worker:

```powershell
python scripts/install_model.py large-v3-turbo
```

The installer stages the declared immutable revision under `MODELS_DIR` and
verifies its repository-controlled hashes before activation. See
[model-security.md](model-security.md) for the separate, disabled-by-default
custom-model configuration-file policy.

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
