# Openflow Desktop

Openflow Desktop is a Windows Electron tray client for the Openflow backend. It turns the local transcription backend into a voice keyboard:

1. Focus a textbox in any Windows app.
2. Press the global hotkey.
3. Speak.
4. Press the hotkey again, or release it if hold mode is enabled.
5. The finalized transcript is pasted into the focused textbox.

The default hotkey is `Ctrl+Alt+Space`. The default activation behavior is toggle.

## Run

### Prerequisites

- Windows 10 or newer.
- Node.js and npm installed.
- Python 3.11 available if you want the app to auto-start the backend.
- A working microphone.
- A local Whisper model installed with `backend/scripts/install_model.py`.

### Start the App

```powershell
cd desktop
npm install
npm start
```

If PowerShell reports that `npm.ps1` cannot be loaded because script execution is disabled, use:

```powershell
npm.cmd install
npm.cmd start
```

The app starts the backend automatically when possible. If `backend/.venv` exists, it runs `backend/scripts/run_server.py`; otherwise it runs `backend/run_backend.ps1`, which creates the venv and installs backend requirements.

Normal startup does not download Whisper models. If the backend reports a missing model, run:

```powershell
cd ..\backend
python scripts/install_model.py large-v3-turbo
```

### Manual Backend Start

```powershell
cd ..\backend
.\run_backend.ps1
```

If PowerShell blocks script execution, use:

```powershell
.\run_backend.bat
```

### Verify Syntax

```powershell
npm run check
```

## Configuration

Open the tray menu and choose `Settings` to configure the app. The tray icon also opens settings on double-click.

The settings UI supports:

- recorded global hotkey
- toggle or hold-to-speak activation
- live backend, model, microphone, LLM, and recording status
- microphone device
- language selector
- fast/accurate mode toggle
- automatic paste
- trailing space after inserted text
- backend WebSocket and health URLs
- backend API token for server-mode backends
- explicit remote backend URL opt-in
- automatic backend startup
- optional local LLM text refinement through llama.cpp or Ollama
- explicit remote LLM URL opt-in

Supported settings:

```json
{
  "backendUrl": "ws://127.0.0.1:8000/v1/transcribe",
  "healthUrl": "http://127.0.0.1:8000/health",
  "backendApiToken": "",
  "allowRemoteBackend": false,
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
  "allowRemoteLlm": false,
  "llmMode": "grammar",
  "llmLatencyBudgetMs": 700,
  "llmMaxBlockingChars": 250
}
```

Remote backend and LLM URLs are rejected unless their matching `allowRemote...` setting is enabled.

## Writing Assistance

The desktop client can optionally refine finalized transcripts before insertion through either an external llama.cpp server that exposes the OpenAI-compatible chat completions API or a local Ollama server.

Short dictations wait up to the configured latency budget for refined text. Longer dictations insert the transcript immediately unless the refinement result is already available. If the server is unavailable or times out, the original transcript is inserted.

## Notes

- Hold mode uses a small Windows key-state watcher so the app can detect hotkey release.
- Text insertion uses the Windows clipboard plus a synthetic `Ctrl+V` keypress. The previous clipboard text is restored shortly after paste when possible.
- The microphone recorder runs in a hidden renderer process and streams raw `pcm_s16le`, mono, 16 kHz audio to the backend WebSocket API.
