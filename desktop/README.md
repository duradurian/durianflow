# TrueScribe

TrueScribe is a minimal Windows Electron client for the Whisper Live backend. It turns the backend into a local voice keyboard:

1. Focus a textbox in any Windows app.
2. Press the global hotkey.
3. Speak.
4. Press the hotkey again, or release it if hold mode is enabled.
5. The finalized transcript is pasted into the focused textbox.

The default hotkey is:

```text
Ctrl+Alt+Space
```

The default activation behavior is toggle. In settings, switch to hold mode if you want dictation to run only while the hotkey is physically held down.

## Run

### Prerequisites

- Windows 10 or newer.
- Node.js and npm installed.
- Python installed and available as `python` if you want the app to auto-start the backend.
- A working microphone.

### Start the App

From the repository root:

```powershell
cd desktop
npm install
npm start
```

If you are starting from this folder already, run:

```powershell
npm install
npm start
```

`npm install` only needs to be run the first time, or after `package.json` changes. `npm start` launches Electron.

If PowerShell reports that `npm.ps1` cannot be loaded because script execution is disabled, use the Windows command shim instead:

```powershell
npm.cmd install
npm.cmd start
```

The app starts the backend automatically when possible. If `backend/.venv` already exists, it starts `uvicorn` directly. Otherwise it runs `backend/run_backend.ps1`, which creates the venv and installs the backend requirements.

On first backend startup, model download and setup can take a while. Leave the Electron app open until the tray status shows the backend is ready.

### Manual Backend Start

If automatic backend startup fails, start the backend in a separate PowerShell window:

```powershell
cd ..\backend
.\run_backend.ps1
```

If PowerShell blocks script execution, use the batch launcher:

```powershell
.\run_backend.bat
```

Then return to `desktop/` and run:

```powershell
npm start
```

### Verify Syntax

To run the desktop JavaScript syntax check:

```powershell
npm run check
```

If PowerShell blocks `npm.ps1`, run:

```powershell
npm.cmd run check
```

## Configuration

Open the tray menu and choose `Settings...` to configure the app. The tray icon also opens settings on double-click.

The settings window is fixed-size and non-resizable. It measures the rendered settings content and locks to the smallest size that fits, clamped to the active display, and it follows the system light/dark theme. Backend and local LLM controls live in a separate Advanced settings window opened from the main settings footer.

The settings UI currently supports:

- recorded global hotkey
- toggle or hold-to-speak activation
- live backend, model, microphone, and recording status
- microphone device
- language selector
- fast/accurate mode toggle
- automatic paste
- trailing space after inserted text
- Advanced settings button
- backend WebSocket and health URLs in the Advanced window
- automatic backend startup
- optional local LLM text refinement through llama.cpp or Ollama
- Advanced window reset

On first run the app also writes a config file into Electron's user data directory. Use the tray menu item `Open Config File` to copy the path.

Hotkeys must use a modifier, such as `Ctrl+Space` or `Alt+Space`, or a dedicated function key such as `F8`. Single letter hotkeys are rejected to avoid conflicting with normal typing.

Supported settings:

```json
{
  "backendUrl": "ws://localhost:8000/v1/transcribe",
  "healthUrl": "http://localhost:8000/health",
  "hotkey": "CommandOrControl+Alt+Space",
  "language": "en",
  "mode": "fast",
  "inputBehavior": "toggle",
  "selectedInputDeviceId": "",
  "autoPaste": true,
  "appendSpace": true,
  "autoStartBackend": true,
  "llmEnabled": false,
  "llmProvider": "llamacpp",
  "llmServerUrl": "http://localhost:8080/v1/chat/completions",
  "llmModel": "local",
  "ollamaServerUrl": "http://localhost:11434",
  "ollamaModel": "",
  "llmMode": "grammar",
  "llmLatencyBudgetMs": 700,
  "llmMaxBlockingChars": 250
}
```

Hotkey and activation changes apply when you save settings.

Set `llmLatencyBudgetMs` to `0` to wait for the local LLM until refinement finishes. Values above `0` cap the short-dictation refinement wait in milliseconds.

## Writing Assistance

The desktop client can optionally refine finalized transcripts before insertion through either an external llama.cpp server that exposes the OpenAI-compatible chat completions API or a local Ollama server. Start your LLM server separately, open Advanced settings, enable refinement, choose the provider and model, then choose `grammar`, `format`, or `enhance`.

For Ollama, the model scan checks the running Ollama API, the `ollama list` CLI output, and local model manifests under the configured Ollama model directory.

Short dictations wait up to the configured latency budget for refined text. Longer dictations insert the transcript immediately unless the refinement result is already available. If the server is unavailable or times out, the original transcript is inserted.

## Notes

- Hold mode uses a small Windows key-state watcher so the app can detect hotkey release.
- Text insertion uses the Windows clipboard plus a synthetic `Ctrl+V` keypress. The previous clipboard text is restored shortly after paste when possible.
- The microphone recorder runs in a hidden renderer process and streams raw `pcm_s16le`, mono, 16 kHz audio to the existing backend WebSocket API.
