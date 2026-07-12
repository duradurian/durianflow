# Troubleshooting

## Speech worker does not start

Create `backend/.venv` from [local-setup.md](local-setup.md). On macOS/Linux the launcher expects `.venv/bin/python`; on Windows it expects `.venv/Scripts/python.exe`. Set `DURIANFLOW_PYTHON` when using another interpreter.

## MLX is unavailable on a Mac

MLX requires Apple Silicon, macOS 14+, and a native arm64 Python. Check:

```bash
python3 -c 'import platform; print(platform.machine())'
python3 -c 'import mlx.core as mx; print(mx.metal.is_available())'
```

Recreate the virtualenv after switching away from a Rosetta/x86 Python. Automatic mode will use CPU if MLX is not installed or Metal cannot be opened.

## Model stays unavailable

Model formats are backend-specific. Install the format selected in Advanced Settings:

```bash
python scripts/install_model.py large-v3-turbo --backend mlx
python scripts/install_model.py large-v3-turbo --backend cpu
```

With downloads disabled, verify `MODEL_PATH` for CTranslate2 or `MLX_MODEL_PATH` for MLX. An incomplete managed download is removed by desktop startup cleanup.

## macOS transcript is copied but not pasted

Enable the app under **System Settings → Privacy & Security → Accessibility**. Then open **Privacy & Security → Automation** and allow it to control System Events. During source development, macOS may list Terminal, Electron, or `osascript` instead. Durianflow intentionally refuses to paste if the focused process or window changed after dictation began.

## macOS microphone permission denied

Enable Durianflow under **System Settings → Privacy & Security → Microphone**, then restart it.

## Windows transcript is copied but not pasted

Durianflow writes the clipboard before sending Ctrl-V. If PowerShell, focus validation, or the target application rejects synthetic input, the transcript remains copied. Disable Auto paste for clipboard-only operation.

## CUDA is unavailable

Choose Automatic or CPU, or follow [nvidia-gpu.md](nvidia-gpu.md). On Windows, `cublas64_12.dll` errors mean the CUDA 12 runtime is not visible to the worker interpreter.

## Hold-to-speak is unavailable

Hold mode currently uses Windows key-state APIs. Use Toggle mode on macOS and Linux.

## No transcript or duplicate text

The VAD ignores silence. Speak above `VAD_ENERGY_THRESHOLD` or lower it cautiously. Choose a smaller model for lower latency. Overlap cleanup reduces repeated phrases, but model rewording can still produce duplicates.

## MLX unified-memory error

Close memory-heavy applications or select a smaller model. MLX weights and working buffers share system memory with macOS and the Electron app.
