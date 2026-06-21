"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const MAX_AUDIO_FRAME_BYTES = 64 * 1024;
const CONFIG_KEYS = new Set([
  "hotkey", "language", "mode", "inputBehavior", "selectedInputDeviceId",
  "autoPaste", "appendSpace", "llmEnabled", "llmProvider", "llmServerUrl",
  "llmModel", "ollamaServerUrl", "ollamaModel", "allowRemoteLlm", "llmMode",
  "llmLatencyBudgetMs", "llmMaxBlockingChars",
]);

function subscribe(channel, callback) {
  if (typeof callback !== "function") throw new TypeError("Event listener must be a function");
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertAllowedObject(value, allowedKeys, name) {
  if (!isPlainObject(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new TypeError(`${name} contains an unsupported field`);
  }
}

function assertArrayBuffer(value) {
  if (!(value instanceof ArrayBuffer)) throw new TypeError("Audio must be an ArrayBuffer");
  if (!value.byteLength || value.byteLength > MAX_AUDIO_FRAME_BYTES || value.byteLength % 2) {
    throw new RangeError("Audio frame exceeds the allowed PCM16 size");
  }
}

function pageRole() {
  const pathname = String(globalThis.location?.pathname || "").toLowerCase();
  if (pathname.endsWith("/recorder.html")) return "recorder";
  if (pathname.endsWith("/settings.html")) return "settings";
  if (pathname.endsWith("/advanced_settings.html")) return "advanced-settings";
  if (pathname.endsWith("/status.html")) return "status";
  return "unknown";
}

const startFields = new Set(["language", "mode", "sampleRate", "channels", "format"]);
const dictation = Object.freeze({
  start: (request = {}) => {
    assertAllowedObject(request, startFields, "Dictation request");
    return ipcRenderer.invoke("dictation:start/request", request);
  },
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

function settingsApi({ primary = false } = {}) {
  const api = {
    getConfig: () => ipcRenderer.invoke("config:get"),
    saveConfig: (patch) => {
      assertAllowedObject(patch, CONFIG_KEYS, "Configuration update");
      return ipcRenderer.invoke("config:save", patch);
    },
    listOllamaModels: (baseUrl) => {
      if (typeof baseUrl !== "string" || baseUrl.length > 2_048) throw new TypeError("Invalid Ollama URL");
      return ipcRenderer.invoke("ollama:models", baseUrl);
    },
    preloadLlm: (patch) => {
      assertAllowedObject(patch, CONFIG_KEYS, "LLM configuration");
      return ipcRenderer.invoke("llm:preload", patch);
    },
    onLlmStatusUpdated: (callback) => subscribe("llm-status:updated", callback),
    onConfigUpdated: (callback) => subscribe("config:updated", callback),
  };
  if (!primary) return api;
  return {
    ...api,
    openAdvancedSettings: () => ipcRenderer.invoke("advanced-settings:open"),
    getAppStatus: () => ipcRenderer.invoke("app-status:get"),
    beginHotkeyCapture: () => ipcRenderer.invoke("hotkey-capture:start"),
    endHotkeyCapture: () => ipcRenderer.invoke("hotkey-capture:end"),
    onHotkeyCaptureCancelled: (callback) => subscribe("hotkey-capture:cancelled", callback),
    fitSettingsWindow: (size) => {
      assertAllowedObject(size, new Set(["width", "height"]), "Window size");
      return ipcRenderer.invoke("settings-window:fit", size);
    },
    onRemeasureSettingsWindow: (callback) => subscribe("settings-window:remeasure", callback),
  };
}

const role = pageRole();
let api;
if (role === "recorder") {
  api = {
    dictation,
    onStartDictation: (callback) => subscribe("dictation:start", callback),
    onStopDictation: (callback) => subscribe("dictation:stop", callback),
  };
} else if (role === "settings") {
  api = settingsApi({ primary: true });
} else if (role === "advanced-settings") {
  api = settingsApi();
} else if (role === "status") {
  api = { onStatusUpdate: (callback) => subscribe("status:update", callback) };
} else {
  api = Object.freeze({});
}

contextBridge.exposeInMainWorld("durianflow", Object.freeze(api));
