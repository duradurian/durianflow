# Troubleshooting

## Speech worker does not start

The default desktop path needs a Python environment at `backend/.venv/Scripts/python.exe`. Recreate it from [local-setup.md](local-setup.md), or set `DURIANFLOW_PYTHON` to a working Python interpreter (`OPENFLOW_PYTHON` is also accepted for compatibility). The desktop status window reports worker/model startup failures.

## Model stays unavailable

Check `backend/.env`, model location, and network access. With downloads disabled, run `python scripts/install_model.py large-v3-turbo` from `backend/` or provide `MODEL_PATH`. The worker reports model state separately from process readiness.

## Desktop hotkey does not trigger

Another program may own the accelerator. Change the hotkey in Settings; Durianflow applies the replacement immediately and reports if registration fails.

## Transcript does not paste

Durianflow writes the transcript to the clipboard then sends synthetic `Ctrl+V`. Focus a normal editable field before stopping. If the target blocks synthetic paste, disable `autoPaste`; the transcript remains on the clipboard.

## Microphone permission denied

Enable microphone access for desktop apps in Windows Privacy & security settings, then restart Durianflow.

## CUDA is unavailable or a CUDA DLL is missing

For the desktop app, choose **CPU** under **Advanced Settings > Speech Model**.
For a directly launched worker, use:

```env
DEVICE=cpu
COMPUTE_TYPE=int8
```

For GPU mode, follow [nvidia-gpu.md](nvidia-gpu.md). `cublas64_12.dll` errors indicate that the CUDA 12 runtime is not available to the worker interpreter.

## No transcript or duplicate text

VAD intentionally ignores silence. Speak above `VAD_ENERGY_THRESHOLD` or lower it cautiously. Overlap cleanup reduces repeated phrases, but model rewording can still produce duplicates. For latency, choose a smaller model, `mode=fast`, and GPU inference where available.
