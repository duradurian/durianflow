# NVIDIA GPU Setup

The backend is configured for NVIDIA GPU inference by default:

```env
DEVICE=cuda
COMPUTE_TYPE=float16
MODEL_NAME=large-v3-turbo
```

`faster-whisper` runs through CTranslate2. Current CTranslate2 GPU wheels require CUDA 12.x. For Whisper speech models, cuDNN is also required.

## Recommended: Docker

Install:

- Current NVIDIA display driver
- Docker Desktop or Docker Engine
- NVIDIA Container Toolkit

Then run:

```bash
cp backend/.env.example backend/.env
docker compose up --build backend
```

Check that Docker can see your GPU:

```bash
docker run --rm --gpus all nvidia/cuda:12.4.1-runtime-ubuntu22.04 nvidia-smi
```

The project Dockerfile uses:

```dockerfile
nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04
```

This image includes CUDA and cuDNN runtime libraries needed by CTranslate2.

## Windows Native Python

If you run `uvicorn` directly on Windows and see:

```text
RuntimeError: Library cublas64_12.dll is not found or cannot be loaded
```

Python cannot find the CUDA 12 cuBLAS runtime.

Fix:

1. Install the Python GPU runtime wheels into the backend venv:

```powershell
cd C:\Users\Darrien\Desktop\code\Openflow\whisper-live\backend
.\.venv\Scripts\python.exe -m pip install -r requirements-gpu-windows.txt
```

The backend automatically registers the wheel DLL directories before loading faster-whisper.

If you prefer a system CUDA install instead:

1. Install an NVIDIA driver that supports CUDA 12.
2. Install NVIDIA CUDA Toolkit 12.x.
3. Install cuDNN for CUDA 12.x.
4. Add these directories to your user or system `PATH`:

```text
C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.x\bin
C:\Program Files\NVIDIA\CUDNN\v9.x\bin
```

The exact cuDNN path depends on where you extracted or installed it. Restart PowerShell after editing `PATH`.

Verify:

```powershell
nvidia-smi
where cublas64_12.dll
where cudnn64*.dll
```

Then start the backend:

```powershell
cd C:\Users\Darrien\Desktop\code\Openflow\whisper-live\backend
.\.venv\Scripts\Activate.ps1
uvicorn app.main:app --reload
```

## Temporary CPU Fallback

If you want the app to run while CUDA is being fixed, set:

```env
DEVICE=cpu
COMPUTE_TYPE=int8
```

CPU mode is slower but avoids CUDA runtime DLL requirements.
