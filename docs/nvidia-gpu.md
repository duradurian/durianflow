# NVIDIA GPU Setup

Openflow runs `faster-whisper` in its local Python worker. The Electron desktop
app launches the worker from `backend/.venv/Scripts/python.exe` during
development, so CUDA DLLs must be visible to that interpreter.

Install a CUDA 12.x runtime and a compatible cuDNN release, then configure
`backend/.env`:

```env
DEVICE=cuda
COMPUTE_TYPE=float16
```

Run the desktop application and inspect its status window to confirm that the
model loads. If CUDA loading fails, Openflow can fall back to CPU int8 when
`FALLBACK_TO_CPU_ON_CUDA_ERROR=true`; set it to `false` to make GPU failures
explicit.

For CPU-only operation, use:

```env
DEVICE=cpu
COMPUTE_TYPE=int8
```
