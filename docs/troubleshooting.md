# Troubleshooting

## Backend Unreachable

Confirm the backend is running and your client is connecting to `ws://127.0.0.1:8000/v1/transcribe`. Check `/health` with a browser or `curl`.

## Desktop Hotkey Does Not Trigger

Another app may already own the accelerator. Open the Electron config file from the tray menu, change `hotkey`, and restart the desktop app.

## Transcript Does Not Paste

The desktop client uses the clipboard plus a synthetic `Ctrl+V`. Make sure a normal editable textbox has focus when you stop dictation. If the target app blocks synthetic paste, set `autoPaste=false`; the transcript will remain on the clipboard.

## Microphone Permission Denied

Windows may block microphone access for desktop apps. Enable microphone access in Windows Privacy & security settings, then restart the desktop client.

## CUDA Not Available

Set `DEVICE=cpu` and `COMPUTE_TYPE=int8` in `backend/.env`, then restart the backend. CUDA mode requires compatible NVIDIA drivers, CUDA libraries, and CTranslate2 GPU support.

## `cublas64_12.dll` Not Found

This means CTranslate2 is running in CUDA mode but Windows cannot find CUDA 12 cuBLAS. Install CUDA Toolkit 12.x and cuDNN for CUDA 12.x, add their `bin` directories to `PATH`, restart PowerShell, then verify:

```powershell
where cublas64_12.dll
where cudnn64*.dll
```

The NVIDIA Docker setup avoids this host DLL problem by using a CUDA/cuDNN runtime image.

## Model Missing

With `ALLOW_MODEL_DOWNLOAD=true`, startup can download and cache the configured Whisper model. If downloads are disabled or blocked, run `python scripts/install_model.py large-v3-turbo` from `backend/`, or set `MODEL_PATH` to an existing faster-whisper model directory.

## Backend Rejects Remote URLs

Openflow desktop mode allows only local backend and LLM URLs by default. Enable the matching Advanced setting only when you intentionally use a trusted remote server.

## No Transcript During Silence

The backend intentionally avoids transcribing silence. Speak above the VAD threshold or lower `VAD_ENERGY_THRESHOLD`.

## Duplicate Text

The MVP uses simple suffix/prefix overlap cleanup. Repeated phrases can still slip through when Whisper changes wording between windows.

## High Latency

Use `MODEL_NAME=small` or `distil-large-v3`, `DEVICE=cuda`, `COMPUTE_TYPE=float16`, and `mode=fast`. Reduce `ROLLING_WINDOW_SECONDS` only if your model remains accurate with less context.
