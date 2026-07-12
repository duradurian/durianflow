# Local setup

The Electron app starts a supervised Python worker over stdio. It does not open a transcription server or port.
Use Python 3.11+ and Node.js 22.12+ for the current dependency set.

## macOS and other POSIX systems

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

## Windows PowerShell

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

The launcher checks `.venv/bin/python` on POSIX and `.venv/Scripts/python.exe` on Windows. Set `DURIANFLOW_PYTHON` to override it; `OPENFLOW_PYTHON` remains a compatibility alias.

## Models and devices

`DEVICE=auto` is the default. It prefers MLX/Metal, then CUDA, then CPU. The desktop Advanced Settings view shows capability results reported by the worker.

Preinstall a model for the selected backend:

```bash
cd backend
python scripts/install_model.py large-v3-turbo --backend auto
```

For fully offline startup, install every backend format Automatic mode may need, then set `ALLOW_MODEL_DOWNLOAD=false`.

See [compute-backends.md](compute-backends.md), [macos.md](macos.md), and [nvidia-gpu.md](nvidia-gpu.md).
