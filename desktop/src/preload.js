const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  if (typeof callback !== "function") {
    throw new TypeError("Dictation event listener must be a function");
  }

  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

function assertArrayBuffer(value) {
  if (!(value instanceof ArrayBuffer)) {
    throw new TypeError("Audio must be an ArrayBuffer");
  }
}

const dictation = Object.freeze({
  start: (config = {}) => ipcRenderer.invoke("dictation:start/request", config),
  sendAudio: (audio) => {
    assertArrayBuffer(audio);
    return ipcRenderer.invoke("dictation:audio", audio);
  },
  stop: () => ipcRenderer.invoke("dictation:stop"),
  cancel: () => ipcRenderer.invoke("dictation:cancel"),
  getState: () => ipcRenderer.invoke("dictation:state:get"),
  onStatus: (callback) => subscribe("dictation:status", callback),
  onTranscript: (callback) => subscribe("dictation:transcript", callback),
  onError: (callback) => subscribe("dictation:error", callback),
  onModelState: (callback) => subscribe("dictation:model-state", callback),
});

contextBridge.exposeInMainWorld("openflow", {
  dictation,
  // Completion remains a one-way notification while the main process owns
  // paste/refinement. It does not expose a general IPC primitive.
  completeDictation: (text) => ipcRenderer.send("dictation:complete", { text }),
  failDictation: (message) => ipcRenderer.send("dictation:error", { message }),
  reportStatus: (state, message, sticky = false) => ipcRenderer.send("dictation:status", { state, message, sticky }),
  // Recorder lifecycle remains controlled by main while the new transport is
  // rolled out. These are fixed, non-generic subscriptions.
  onStartDictation: (callback) => subscribe("dictation:start", callback),
  onStopDictation: (callback) => subscribe("dictation:stop", callback),
  onStatusUpdate: (callback) => subscribe("status:update", callback),
  onLlmStatusUpdated: (callback) => subscribe("llm-status:updated", callback),
  onConfigUpdated: (callback) => subscribe("config:updated", callback),
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),
  listOllamaModels: (baseUrl) => ipcRenderer.invoke("ollama:models", baseUrl),
  preloadLlm: (config) => ipcRenderer.invoke("llm:preload", config),
  openAdvancedSettings: () => ipcRenderer.invoke("advanced-settings:open"),
  getAppStatus: () => ipcRenderer.invoke("app-status:get"),
  beginHotkeyCapture: () => ipcRenderer.invoke("hotkey-capture:start"),
  endHotkeyCapture: () => ipcRenderer.invoke("hotkey-capture:end"),
  onHotkeyCaptureCancelled: (callback) => subscribe("hotkey-capture:cancelled", callback),
  fitSettingsWindow: (size) => ipcRenderer.invoke("settings-window:fit", size),
  onRemeasureSettingsWindow: (callback) => subscribe("settings-window:remeasure", callback),
});
