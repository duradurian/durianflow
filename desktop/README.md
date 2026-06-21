# Openflow Desktop

Run the Electron client from this directory:

```powershell
npm install
npm start
```

Electron starts `backend/scripts/run_worker.py` as a supervised local child
process. The recorder captures mono 16 kHz PCM16 audio and uses a narrow
contextBridge IPC API; it does not connect to a network transcription service.

The main settings cover hotkey, microphone, language, transcription mode, and
paste behavior. Advanced settings configure only optional local LLM refinement
through llama.cpp or Ollama.

Run `npm run check` to syntax-check desktop source files.
