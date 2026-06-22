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
paste behavior. Advanced settings configure optional local LLM refinement
through llama.cpp or Ollama and manage faster-whisper model profiles. Configure
separate Fast and Accurate models, download either profile, and switch profiles
without sharing renderer access to the model files. A downloaded profile starts
in the worker immediately for validation and warm-up.

The speech-model panel shows installed size, storage path, free disk space, and
live download bytes, speed, elapsed time, and total size when the model host
supplies metadata. The app removes stale incomplete model downloads before it
starts the worker. It can delete managed model downloads; it does not delete an
external `MODEL_PATH`.

Choose **NVIDIA GPU (CUDA)** or **CPU** in the Speech Model panel. The selected
device restarts the local worker; CPU uses int8 inference and changes the main
Settings resource meter from GPU memory to combined app and worker RAM.

Run `npm run check` to syntax-check desktop source files.
