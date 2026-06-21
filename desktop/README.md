# Durianflow Desktop

Run the Electron client from this directory:

```powershell
npm install
npm start
```

Electron starts `backend/scripts/run_worker.py` as a supervised local child
process. The recorder captures mono 16 kHz PCM16 audio and uses a narrow
contextBridge IPC API; it does not connect to a network transcription service.

The main settings cover hotkey, microphone, language, transcription mode, and
paste behavior. Clipboard copy is the default. Automatic paste is an explicit
opt-in and must fall back to copy-only completion if the originally captured
foreground target cannot be revalidated. Advanced settings configure only
optional local LLM refinement through llama.cpp or Ollama.

The desktop app is not a security boundary against malware, an administrator,
or an unlocked Windows session. Dictation results are placed on the clipboard;
avoid enabling automatic paste for workflows where an unexpected target would
be harmful.

Run `npm run check` to syntax-check desktop source files.
