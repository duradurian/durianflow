# Durianflow Desktop

The Electron tray client is supported for source development on macOS and Windows.
Use Node.js 22.12 or newer and a Python 3.11+ backend environment.

```bash
npm install
npm start
```

It launches `backend/scripts/run_worker.py` as a supervised stdio child, captures mono 16 kHz PCM16 audio, and exposes only fixed IPC calls through the context bridge.

Interpreter discovery is platform-aware:

- macOS/Linux: `backend/.venv/bin/python`, then `python3`.
- Windows: `backend/.venv/Scripts/python.exe`, then `python`.
- Override: `DURIANFLOW_PYTHON`.

Advanced Settings defaults to Automatic inference, which prefers Apple MLX/Metal, then NVIDIA CUDA, then CPU. Managed model actions use the resolved engine’s model format.

On macOS, auto-paste captures and revalidates the frontmost process plus Core Graphics window before sending Command-V. Accessibility or Automation denial, focus changes, and ambiguous completion leave the transcript copied and are never retried. Windows retains the warmed PowerShell/user32 helper and atomic Ctrl-V focus check.

Toggle shortcuts work across platforms. Hold-to-speak remains Windows-only. MLX resource status is reported as unified memory; CUDA uses NVIDIA VRAM.

Run checks with:

```bash
npm run check
npm test
```

See [the macOS guide](../docs/macos.md) and [compute backend guide](../docs/compute-backends.md).
