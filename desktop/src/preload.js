const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("openflow", {
  onStartDictation: (callback) => ipcRenderer.on("dictation:start", (_event, config) => callback(config)),
  onStopDictation: (callback) => ipcRenderer.on("dictation:stop", () => callback()),
  completeDictation: (text) => ipcRenderer.send("dictation:complete", { text }),
  failDictation: (message) => ipcRenderer.send("dictation:error", { message }),
  reportStatus: (state, message, sticky = false) => ipcRenderer.send("dictation:status", { state, message, sticky }),
  onStatusUpdate: (callback) => ipcRenderer.on("status:update", (_event, status) => callback(status)),
  onLlmStatusUpdated: (callback) => ipcRenderer.on("llm-status:updated", (_event, status) => callback(status)),
  onConfigUpdated: (callback) => ipcRenderer.on("config:updated", (_event, config) => callback(config)),
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),
  testBackend: (healthUrl) => ipcRenderer.invoke("backend:test", healthUrl),
  listOllamaModels: (baseUrl) => ipcRenderer.invoke("ollama:models", baseUrl),
  preloadLlm: (config) => ipcRenderer.invoke("llm:preload", config),
  openAdvancedSettings: () => ipcRenderer.invoke("advanced-settings:open"),
  getAppStatus: () => ipcRenderer.invoke("app-status:get"),
  beginHotkeyCapture: () => ipcRenderer.invoke("hotkey-capture:start"),
  endHotkeyCapture: () => ipcRenderer.invoke("hotkey-capture:end"),
  onHotkeyCaptureCancelled: (callback) => ipcRenderer.on("hotkey-capture:cancelled", () => callback()),
  fitSettingsWindow: (size) => ipcRenderer.invoke("settings-window:fit", size),
  onRemeasureSettingsWindow: (callback) => ipcRenderer.on("settings-window:remeasure", () => callback()),
});
