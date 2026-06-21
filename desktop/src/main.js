const { app, BrowserWindow, Menu, Tray, clipboard, globalShortcut, ipcMain, nativeImage, screen } = require("electron");
const { execFile, spawn } = require("child_process");
const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");
const { PRODUCT_NAME, SETTINGS_TITLE, ADVANCED_SETTINGS_TITLE } = require("./product_identity");
const {
  DEFAULT_LLAMACPP_URL,
  DEFAULT_LLM_URL,
  DEFAULT_OLLAMA_URL,
  listOllamaModels,
  preloadLlm,
  refineText,
  shouldAttemptRefinement,
  shouldBlockForRefinement,
  unloadOtherOllamaModels,
  unloadOllamaModel,
} = require("./text_processor");
const { sanitizeHttpServiceUrl } = require("./url_policy");
const { createDictationTransport } = require("./dictation_transport");
const {
  assertTrustedFileSender,
  installPermissionPolicy,
  isTrustedFileSender,
  registerTrustedWindow,
  secureWebPreferences,
} = require("./window_security");

const DEFAULT_CONFIG = {
  hotkey: "CommandOrControl+Alt+Space",
  language: "en",
  mode: "fast",
  inputBehavior: "toggle",
  selectedInputDeviceId: "",
  // Pasting into the foreground application is an explicit opt-in.  A
  // transcript is always copied first, which is safe when foreground-window
  // verification is unavailable.
  autoPaste: false,
  appendSpace: true,
  llmEnabled: false,
  llmProvider: "llamacpp",
  llmServerUrl: DEFAULT_LLAMACPP_URL,
  llmModel: "local",
  ollamaServerUrl: DEFAULT_OLLAMA_URL,
  ollamaModel: "",
  allowRemoteLlm: false,
  llmMode: "grammar",
  llmLatencyBudgetMs: 700,
  llmMaxBlockingChars: 250,
};

let config = { ...DEFAULT_CONFIG };
let recorderWindow;
let statusWindow;
let settingsWindow;
let advancedSettingsWindow;
let tray;
let localWorkerTransport;
let hotkeyWatcherProcess;
let isRecording = false;
let isStartingDictation = false;
let cancelStartingDictation = false;
let dictationStartAbortController;
let isQuitting = false;
let isCapturingHotkey = false;
let llmLoadState = { key: "", state: "off", provider: "", baseUrl: "", model: "" };
let llmLoadRequestId = 0;
let dictationSession = null;

const MAX_AUDIO_FRAME_BYTES = 64 * 1024;
const MAX_IPC_STRING_LENGTH = 5_000;
const FINALIZATION_TIMEOUT_MS = 30_000;
const CONFIG_KEYS = Object.freeze([
  "hotkey",
  "language",
  "mode",
  "inputBehavior",
  "selectedInputDeviceId",
  "autoPaste",
  "appendSpace",
  "llmEnabled",
  "llmProvider",
  "llmServerUrl",
  "llmModel",
  "ollamaServerUrl",
  "ollamaModel",
  "allowRemoteLlm",
  "llmMode",
  "llmLatencyBudgetMs",
  "llmMaxBlockingChars",
]);

const rootDir = path.resolve(__dirname, "..", "..");
const backendDir = path.join(rootDir, "backend");
const SETTINGS_WINDOW = {
  initialWidth: 700,
  initialHeight: 500,
  margin: 18,
};
const ADVANCED_SETTINGS_WINDOW = {
  width: 680,
  height: 620,
  margin: 18,
};

function configPath() {
  return path.join(app.getPath("userData"), "config.json");
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    config = sanitizeConfig(JSON.parse(raw));
  } catch {
    config = { ...DEFAULT_CONFIG };
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function securityLog(code, details = {}) {
  // Keep security telemetry structural: never log transcripts, audio, IPC
  // payloads, credentials, or untrusted exception text.
  const safe = {};
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === "string") safe[key] = value.slice(0, 80);
    else if (typeof value === "number" || typeof value === "boolean") safe[key] = value;
  }
  console.warn(`[security] ${code}`, safe);
}

function acceleratorParts(accelerator) {
  return String(accelerator || "")
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
}

function isModifierKey(part) {
  return ["CommandOrControl", "Command", "Control", "Ctrl", "Alt", "Shift", "Super", "Meta"].includes(part);
}

function isSpecialHotkey(part) {
  return /^F([1-9]|1[0-9]|2[0-4])$/.test(part)
    || ["Pause", "PrintScreen", "Insert", "Home", "End", "PageUp", "PageDown"].includes(part);
}

function isSafeAccelerator(accelerator) {
  const parts = acceleratorParts(accelerator);
  const trigger = parts.find((part) => !isModifierKey(part));
  const hasModifier = parts.some(isModifierKey);
  return Boolean(trigger && (hasModifier || isSpecialHotkey(trigger)));
}

function sanitizeConfig(nextConfig) {
  // Never spread a renderer- or file-controlled object into configuration.
  // Unknown keys are deliberately ignored on load and rejected for IPC saves.
  const source = isPlainObject(nextConfig) ? nextConfig : {};
  const booleanSetting = (value, defaultValue) => (typeof value === "boolean" ? value : defaultValue);
  const numericSetting = (value, defaultValue, min, max) => {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return defaultValue;
    }
    return Math.min(max, Math.max(min, Math.round(number)));
  };
  const hotkey = String(source.hotkey || DEFAULT_CONFIG.hotkey).trim();
  const llmMode = ["off", "grammar", "format", "enhance"].includes(source.llmMode)
    ? source.llmMode
    : DEFAULT_CONFIG.llmMode;
  const llmProvider = ["llamacpp", "ollama"].includes(source.llmProvider)
    ? source.llmProvider
    : DEFAULT_CONFIG.llmProvider;
  const allowRemoteLlm = booleanSetting(source.allowRemoteLlm, DEFAULT_CONFIG.allowRemoteLlm);

  return {
    hotkey: isSafeAccelerator(hotkey) ? hotkey : DEFAULT_CONFIG.hotkey,
    language: source.language ? String(source.language).trim() : null,
    mode: source.mode === "accurate" ? "accurate" : "fast",
    inputBehavior: source.inputBehavior === "hold" ? "hold" : "toggle",
    selectedInputDeviceId: String(source.selectedInputDeviceId || ""),
    autoPaste: booleanSetting(source.autoPaste, DEFAULT_CONFIG.autoPaste),
    appendSpace: booleanSetting(source.appendSpace, DEFAULT_CONFIG.appendSpace),
    llmEnabled: booleanSetting(source.llmEnabled, DEFAULT_CONFIG.llmEnabled),
    llmProvider,
    llmServerUrl: sanitizeHttpServiceUrl(source.llmServerUrl, DEFAULT_LLM_URL, allowRemoteLlm),
    llmModel: String(source.llmModel || DEFAULT_CONFIG.llmModel).trim(),
    ollamaServerUrl: sanitizeHttpServiceUrl(
      source.ollamaServerUrl,
      DEFAULT_CONFIG.ollamaServerUrl,
      allowRemoteLlm,
    ),
    ollamaModel: String(source.ollamaModel || DEFAULT_CONFIG.ollamaModel).trim(),
    allowRemoteLlm,
    llmMode,
    llmLatencyBudgetMs: numericSetting(
      source.llmLatencyBudgetMs,
      DEFAULT_CONFIG.llmLatencyBudgetMs,
      0,
      5000,
    ),
    llmMaxBlockingChars: numericSetting(
      source.llmMaxBlockingChars,
      DEFAULT_CONFIG.llmMaxBlockingChars,
      1,
      5000,
    ),
  };
}

function validateConfigPatch(nextConfig) {
  if (!isPlainObject(nextConfig)) {
    throw new TypeError("Configuration update must be an object");
  }
  const patch = Object.create(null);
  for (const key of Object.keys(nextConfig)) {
    if (!CONFIG_KEYS.includes(key)) {
      securityLog("config_rejected_unknown_key", { key });
      throw new TypeError("Configuration update contains an unsupported field");
    }
    patch[key] = nextConfig[key];
  }
  return patch;
}

function mergeConfigPatch(baseConfig, patch) {
  const merged = Object.create(null);
  for (const key of CONFIG_KEYS) {
    merged[key] = Object.hasOwn(patch, key) ? patch[key] : baseConfig[key];
  }
  return merged;
}

function publicConfig() {
  const visible = Object.create(null);
  for (const key of CONFIG_KEYS) visible[key] = config[key];
  return visible;
}

function saveConfig() {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  const target = configPath();
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(publicConfig(), null, 2), { encoding: "utf8", mode: 0o600 });
    try { fs.chmodSync(temporary, 0o600); } catch {}
    fs.renameSync(temporary, target);
    try { fs.chmodSync(target, 0o600); } catch {}
  } finally {
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    } catch {}
  }
}

function llmDescriptor(sourceConfig = config) {
  const provider = sourceConfig.llmProvider === "ollama" ? "ollama" : "llamacpp";
  if (provider === "ollama") {
    const baseUrl = String(sourceConfig.ollamaServerUrl || DEFAULT_OLLAMA_URL).trim();
    const model = String(sourceConfig.ollamaModel || "").trim();
    return {
      provider,
      baseUrl,
      model,
      key: [
        provider,
        baseUrl,
        model,
      ].join("|"),
    };
  }

  const baseUrl = String(sourceConfig.llmServerUrl || DEFAULT_LLAMACPP_URL).trim();
  const model = String(sourceConfig.llmModel || "local").trim();
  return {
    provider,
    baseUrl,
    model,
    key: [
      provider,
      baseUrl,
      model,
    ].join("|"),
  };
}

function llmPreloadKey(sourceConfig = config) {
  return llmDescriptor(sourceConfig).key;
}

function llmStatus(sourceConfig = config) {
  if (!sourceConfig.llmEnabled) {
    return { state: "off", message: "Off" };
  }

  const key = llmPreloadKey(sourceConfig);
  if (llmLoadState.key === key && llmLoadState.state === "ready") {
    const model = llmDescriptor(sourceConfig).model;
    return { state: "ready", message: model || "Ready" };
  }

  return { state: "starting", message: "Starting" };
}

function notifyLlmStatusUpdated(sourceConfig = config) {
  for (const window of [settingsWindow, advancedSettingsWindow]) {
    if (window && !window.isDestroyed()) {
      window.webContents.send("llm-status:updated", llmStatus(sourceConfig));
    }
  }
}

async function unloadCurrentOllamaModel() {
  const previous = llmLoadState;
  if (previous.provider === "ollama" && previous.model) {
    await unloadOllamaModel(previous.baseUrl, previous.model);
  }
}

function setLlmOff() {
  llmLoadRequestId += 1;
  llmLoadState = { key: "", state: "off", provider: "", baseUrl: "", model: "" };
  notifyLlmStatusUpdated();
}

async function disableConfiguredLlm() {
  llmLoadRequestId += 1;
  await unloadCurrentOllamaModel();
  llmLoadState = { key: "", state: "off", provider: "", baseUrl: "", model: "" };
  notifyLlmStatusUpdated();
}

async function unloadPreviousOllamaModel(nextDescriptor) {
  if (nextDescriptor.provider === "ollama") {
    await unloadOtherOllamaModels(nextDescriptor.baseUrl, nextDescriptor.model);
  }

  const previous = llmLoadState;
  if (
    previous.provider !== "ollama"
    || !previous.model
    || (
      nextDescriptor.provider === "ollama"
      && previous.baseUrl === nextDescriptor.baseUrl
      && previous.model === nextDescriptor.model
    )
  ) {
    return;
  }

  await unloadOllamaModel(previous.baseUrl, previous.model);
}

async function preloadConfiguredLlm(sourceConfig = config, options = {}) {
  const preloadConfig = sanitizeConfig(sourceConfig);
  if (!preloadConfig.llmEnabled) {
    await disableConfiguredLlm();
    return llmStatus(preloadConfig);
  }

  const descriptor = llmDescriptor(preloadConfig);
  if (!options.force && llmLoadState.key === descriptor.key && llmLoadState.state === "ready") {
    return llmStatus(preloadConfig);
  }

  const requestId = ++llmLoadRequestId;
  await unloadPreviousOllamaModel(descriptor);
  llmLoadState = { ...descriptor, state: "starting" };
  notifyLlmStatusUpdated(preloadConfig);
  const result = await preloadLlm(preloadConfig);

  if (requestId === llmLoadRequestId) {
    llmLoadState = { ...descriptor, state: result.ok ? "ready" : "starting" };
    notifyLlmStatusUpdated(preloadConfig);
  }

  return llmStatus(preloadConfig);
}

function preloadConfiguredLlmInBackground(sourceConfig = config, options = {}) {
  if (!sourceConfig.llmEnabled) {
    disableConfiguredLlm().catch(() => {
      setLlmOff();
    });
    return;
  }

  preloadConfiguredLlm(sourceConfig, options).catch(() => {
    const descriptor = llmDescriptor(sourceConfig);
    if (llmLoadState.key === descriptor.key) {
      llmLoadState = { ...descriptor, state: "starting" };
      notifyLlmStatusUpdated(sourceConfig);
    }
  });
}

function createTrayIcon() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <rect width="32" height="32" rx="7" fill="#111827"/>
      <path d="M16 5a4 4 0 0 0-4 4v7a4 4 0 0 0 8 0V9a4 4 0 0 0-4-4Z" fill="#f9fafb"/>
      <path d="M9 15a1 1 0 1 0-2 0 9 9 0 0 0 8 8.94V27a1 1 0 1 0 2 0v-3.06A9 9 0 0 0 25 15a1 1 0 1 0-2 0 7 7 0 1 1-14 0Z" fill="#38bdf8"/>
    </svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
}

function setTrayMenu() {
  const label = isRecording || isStartingDictation ? "Stop" : "Dictate";
  tray.setContextMenu(Menu.buildFromTemplate([
    { label, click: toggleDictation },
    { label: "Settings", click: openSettingsWindow },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
}

function createRecorderWindow() {
  recorderWindow = new BrowserWindow({
    width: 240,
    height: 160,
    show: false,
    title: `${PRODUCT_NAME} Recorder`,
    webPreferences: secureWebPreferences({
      preload: path.join(__dirname, "preload.js"),
      backgroundThrottling: false,
      devTools: !app.isPackaged,
    }),
  });

  recorderWindow.loadFile(path.join(__dirname, "recorder.html"));
  registerTrustedWindow(recorderWindow);
  recorderWindow.on("closed", () => {
    if (!dictationSession) return;
    const session = dictationSession;
    endDictationSession(session, "cancelled");
    try { localWorkerTransport?.cancel(); } catch {}
  });
}

function createStatusWindow() {
  statusWindow = new BrowserWindow({
    width: 360,
    height: 96,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    show: false,
    transparent: true,
    title: `${PRODUCT_NAME} Status`,
    webPreferences: secureWebPreferences({
      preload: path.join(__dirname, "preload.js"),
      devTools: !app.isPackaged,
    }),
  });

  statusWindow.loadFile(path.join(__dirname, "status.html"));
  registerTrustedWindow(statusWindow);
}

function settingsWindowBounds() {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor) || screen.getPrimaryDisplay();
  const { x, y, width, height } = display.workArea;
  const targetWidth = Math.min(width - SETTINGS_WINDOW.margin * 2, SETTINGS_WINDOW.initialWidth);
  const targetHeight = Math.min(height - SETTINGS_WINDOW.margin * 2, SETTINGS_WINDOW.initialHeight);

  return {
    x: Math.round(x + (width - targetWidth) / 2),
    y: Math.round(y + (height - targetHeight) / 2),
    width: targetWidth,
    height: targetHeight,
  };
}

function fitSettingsWindowToContent(requestedSize = {}) {
  if (!settingsWindow || settingsWindow.isDestroyed()) {
    return null;
  }

  const currentBounds = settingsWindow.getBounds();
  const center = {
    x: currentBounds.x + Math.round(currentBounds.width / 2),
    y: currentBounds.y + Math.round(currentBounds.height / 2),
  };
  const display = screen.getDisplayNearestPoint(center) || screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const maxContentWidth = Math.max(620, workArea.width - SETTINGS_WINDOW.margin * 2);
  const maxContentHeight = Math.max(460, workArea.height - SETTINGS_WINDOW.margin * 2);
  const contentWidth = Math.min(maxContentWidth, Math.max(620, Math.ceil(requestedSize.width || SETTINGS_WINDOW.initialWidth)));
  const contentHeight = Math.min(maxContentHeight, Math.max(420, Math.ceil(requestedSize.height || SETTINGS_WINDOW.initialHeight)));

  settingsWindow.setMinimumSize(1, 1);
  settingsWindow.setMaximumSize(workArea.width, workArea.height);
  settingsWindow.setContentSize(contentWidth, contentHeight);

  const fittedBounds = settingsWindow.getBounds();
  const clampedX = Math.min(
    Math.max(fittedBounds.x, workArea.x),
    Math.max(workArea.x, workArea.x + workArea.width - fittedBounds.width),
  );
  const clampedY = Math.min(
    Math.max(fittedBounds.y, workArea.y),
    Math.max(workArea.y, workArea.y + workArea.height - fittedBounds.height),
  );
  const nextBounds = {
    ...fittedBounds,
    x: Math.round(clampedX),
    y: Math.round(clampedY),
  };

  settingsWindow.setBounds(nextBounds);
  settingsWindow.setMinimumSize(nextBounds.width, nextBounds.height);
  settingsWindow.setMaximumSize(nextBounds.width, nextBounds.height);
  return nextBounds;
}

function createSettingsWindow() {
  const bounds = settingsWindowBounds();
  settingsWindow = new BrowserWindow({
    ...bounds,
    minWidth: bounds.width,
    minHeight: bounds.height,
    maxWidth: bounds.width,
    maxHeight: bounds.height,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: SETTINGS_TITLE,
    webPreferences: secureWebPreferences({
      preload: path.join(__dirname, "preload.js"),
      devTools: !app.isPackaged,
    }),
  });

  settingsWindow.loadFile(path.join(__dirname, "settings.html"));
  registerTrustedWindow(settingsWindow);
  settingsWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      if (isCapturingHotkey) {
        settingsWindow.webContents.send("hotkey-capture:cancelled");
      }
      endHotkeyCapture();
      settingsWindow.hide();
    }
  });
}

function advancedSettingsWindowBounds() {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor) || screen.getPrimaryDisplay();
  const { x, y, width, height } = display.workArea;
  const targetWidth = Math.min(width - ADVANCED_SETTINGS_WINDOW.margin * 2, ADVANCED_SETTINGS_WINDOW.width);
  const targetHeight = Math.min(height - ADVANCED_SETTINGS_WINDOW.margin * 2, ADVANCED_SETTINGS_WINDOW.height);

  return {
    x: Math.round(x + (width - targetWidth) / 2),
    y: Math.round(y + (height - targetHeight) / 2),
    width: targetWidth,
    height: targetHeight,
  };
}

function createAdvancedSettingsWindow() {
  const bounds = advancedSettingsWindowBounds();
  advancedSettingsWindow = new BrowserWindow({
    ...bounds,
    minWidth: Math.min(620, bounds.width),
    minHeight: Math.min(520, bounds.height),
    maxWidth: bounds.width,
    maxHeight: bounds.height,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: ADVANCED_SETTINGS_TITLE,
    parent: settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : undefined,
    webPreferences: secureWebPreferences({
      preload: path.join(__dirname, "preload.js"),
      devTools: !app.isPackaged,
    }),
  });

  advancedSettingsWindow.loadFile(path.join(__dirname, "advanced_settings.html"));
  registerTrustedWindow(advancedSettingsWindow);
  advancedSettingsWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      advancedSettingsWindow.hide();
    }
  });
}

function openSettingsWindow() {
  if (!settingsWindow || settingsWindow.isDestroyed()) {
    createSettingsWindow();
  }
  settingsWindow.webContents.send("settings-window:remeasure");
  settingsWindow.show();
  settingsWindow.focus();
}

function openAdvancedSettingsWindow() {
  if (!advancedSettingsWindow || advancedSettingsWindow.isDestroyed()) {
    createAdvancedSettingsWindow();
  }
  advancedSettingsWindow.show();
  advancedSettingsWindow.focus();
}

function notifyConfigUpdated() {
  for (const window of [settingsWindow, advancedSettingsWindow]) {
    if (window && !window.isDestroyed()) {
      window.webContents.send("config:updated", publicConfig());
    }
  }
}

function positionStatusWindow() {
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.workArea;
  statusWindow.setBounds({
    x: Math.max(x + 16, x + width - 392),
    y: Math.max(y + 16, y + height - 132),
    width: 360,
    height: 96,
  });
}

let statusHideTimer;

function showStatus(state, message, sticky = false) {
  if (!statusWindow || statusWindow.isDestroyed()) {
    return;
  }
  positionStatusWindow();
  statusWindow.webContents.send("status:update", { state, message });
  statusWindow.showInactive();
  clearTimeout(statusHideTimer);
  if (!sticky) {
    statusHideTimer = setTimeout(() => {
      if (statusWindow && !statusWindow.isDestroyed()) {
        statusWindow.hide();
      }
    }, 2400);
  }
}

function stopHotkeyWatcher() {
  if (hotkeyWatcherProcess) {
    hotkeyWatcherProcess.kill();
    hotkeyWatcherProcess = null;
  }
}

function stopShortcutRegistration() {
  globalShortcut.unregisterAll();
  stopHotkeyWatcher();
}

function keyToVirtualKey(key) {
  if (/^[A-Z]$/.test(key)) {
    return key.charCodeAt(0);
  }
  if (/^[0-9]$/.test(key)) {
    return key.charCodeAt(0);
  }
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) {
    return 111 + Number(key.slice(1));
  }

  return {
    CommandOrControl: 0x11,
    Control: 0x11,
    Ctrl: 0x11,
    Alt: 0x12,
    Shift: 0x10,
    Space: 0x20,
    Tab: 0x09,
    Enter: 0x0d,
    Esc: 0x1b,
    Escape: 0x1b,
    Backspace: 0x08,
    Delete: 0x2e,
    Insert: 0x2d,
    Home: 0x24,
    End: 0x23,
    PageUp: 0x21,
    PageDown: 0x22,
    Up: 0x26,
    Down: 0x28,
    Left: 0x25,
    Right: 0x27,
    "`": 0xc0,
    "-": 0xbd,
    "=": 0xbb,
    "[": 0xdb,
    "]": 0xdd,
    "\\": 0xdc,
    ";": 0xba,
    "'": 0xde,
    ",": 0xbc,
    ".": 0xbe,
    "/": 0xbf,
  }[key];
}

function acceleratorToVirtualKeys(accelerator) {
  return acceleratorParts(accelerator)
    .map((part) => keyToVirtualKey(part.trim()))
    .filter((key) => Number.isInteger(key));
}

async function startKeyStateWatcher(mode) {
  const isHoldMode = mode === "hold";
  if (process.platform !== "win32") {
    if (isHoldMode) {
      showStatus("error", "Hold mode is currently available on Windows only", true);
    }
    return false;
  }

  const parts = acceleratorParts(config.hotkey);
  const keys = acceleratorToVirtualKeys(config.hotkey);
  if (!keys.length || keys.length !== parts.length) {
    if (isHoldMode) {
      showStatus("error", `Unsupported hold hotkey: ${config.hotkey}`, true);
    }
    return false;
  }

  const keyArray = keys.join(",");
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class KeyState {
  [DllImport("user32.dll")]
  public static extern short GetAsyncKeyState(int vKey);
}
"@
$keys = @(${keyArray})
$wasDown = $false
Write-Output "READY"
[Console]::Out.Flush()
while ($true) {
  $down = $true
  foreach ($key in $keys) {
    if (([KeyState]::GetAsyncKeyState($key) -band 0x8000) -eq 0) {
      $down = $false
      break
    }
  }
  if ($down -and -not $wasDown) {
    Write-Output "DOWN"
    [Console]::Out.Flush()
  } elseif (-not $down -and $wasDown) {
    Write-Output "UP"
    [Console]::Out.Flush()
  }
  $wasDown = $down
  Start-Sleep -Milliseconds 35
}`;

  return new Promise((resolve) => {
    let watcher;
    let ready = false;
    let settled = false;
    const settle = (result) => {
      if (!settled) {
        settled = true;
        clearTimeout(readyTimer);
        resolve(result);
      }
    };
    const readyTimer = setTimeout(() => {
      if (hotkeyWatcherProcess === watcher) {
        hotkeyWatcherProcess.kill();
        hotkeyWatcherProcess = null;
      }
      settle(false);
    }, 2000);

    try {
      watcher = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      settle(false);
      return;
    }
    hotkeyWatcherProcess = watcher;

    watcher.stdout.on("data", (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        const event = line.trim();
        if (event === "READY") {
          ready = true;
          settle(true);
        } else if (event === "DOWN") {
          if (isHoldMode) {
            startDictation();
          } else {
            toggleDictation();
          }
        } else if (event === "UP" && isHoldMode) {
          stopDictation();
        }
      }
    });

    watcher.on("error", () => {
      if (hotkeyWatcherProcess === watcher) {
        hotkeyWatcherProcess = null;
        showStatus("error", `Could not monitor hotkey: ${config.hotkey}`, true);
      }
      settle(false);
    });
    watcher.on("exit", () => {
      if (hotkeyWatcherProcess === watcher) {
        hotkeyWatcherProcess = null;
        if (ready) {
          showStatus("error", `Could not monitor hotkey: ${config.hotkey}`, true);
        }
      }
      settle(false);
    });
  });
}

async function applyShortcutRegistration() {
  stopShortcutRegistration();
  if (isCapturingHotkey) {
    return true;
  }

  if (config.inputBehavior === "hold") {
    return startKeyStateWatcher("hold");
  }

  const ok = globalShortcut.register(config.hotkey, toggleDictation);
  if (ok) {
    return true;
  }
  if (await startKeyStateWatcher("toggle")) {
    return true;
  }
  showStatus("error", `Could not register hotkey: ${config.hotkey}`, true);
  return false;
}

async function endHotkeyCapture() {
  isCapturingHotkey = false;
  return { ok: await applyShortcutRegistration() };
}

function execFileText(command, args, timeoutMs = 1200) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve("");
        return;
      }
      resolve(String(stdout || ""));
    });
  });
}

async function gpuMemoryStatus() {
  const output = await execFileText("nvidia-smi", [
    "--query-gpu=memory.used,memory.total",
    "--format=csv,noheader,nounits",
  ]);
  const rows = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let usedMb = 0;
  let totalMb = 0;
  for (const row of rows) {
    const [used, total] = row.split(",").map((value) => Number(String(value || "").trim()));
    if (Number.isFinite(used) && Number.isFinite(total) && total > 0) {
      usedMb += used;
      totalMb += total;
    }
  }

  if (!totalMb) {
    return { ok: false, used: 0, total: 0, percent: 0 };
  }

  return {
    ok: true,
    used: usedMb * 1024 * 1024,
    total: totalMb * 1024 * 1024,
    percent: Math.round((usedMb / totalMb) * 100),
  };
}

function isRecorderSender(event) {
  return Boolean(
    recorderWindow
    && !recorderWindow.isDestroyed()
    && event?.sender?.id === recorderWindow.webContents.id,
  );
}

function assertRecorderSender(event) {
  assertTrustedFileSender(event);
  if (!isRecorderSender(event)) {
    securityLog("ipc_rejected_wrong_window", { channel: "dictation" });
    throw new Error("Dictation IPC is only available to the recorder window");
  }
}

function isSettingsSender(event) {
  return Boolean(
    [settingsWindow, advancedSettingsWindow].some((window) => (
      window && !window.isDestroyed() && event?.sender?.id === window.webContents.id
    )),
  );
}

function assertSettingsSender(event) {
  assertTrustedFileSender(event);
  if (!isSettingsSender(event)) {
    securityLog("ipc_rejected_wrong_window", { channel: "settings" });
    throw new Error("Settings IPC is only available to settings windows");
  }
}

function assertPrimarySettingsSender(event) {
  assertTrustedFileSender(event);
  if (!settingsWindow || settingsWindow.isDestroyed() || event?.sender?.id !== settingsWindow.webContents.id) {
    securityLog("ipc_rejected_wrong_window", { channel: "primary-settings" });
    throw new Error("This action is only available to the settings window");
  }
}

async function captureForegroundTarget() {
  if (process.platform !== "win32") return null;
  const script = [
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class DurianflowForeground { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId); }'",
    "$window = [DurianflowForeground]::GetForegroundWindow()",
    "$processId = 0",
    "[void][DurianflowForeground]::GetWindowThreadProcessId($window, [ref]$processId)",
    "if ($window -ne [IntPtr]::Zero -and $processId -gt 0) { Write-Output ($window.ToInt64().ToString() + '|' + $processId.ToString()) }",
  ].join("\n");
  const output = await execFileText("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 750);
  const match = output.trim().match(/^(-?\d+)\|(\d+)$/);
  return match ? { window: match[1], processId: match[2] } : null;
}

function sameForegroundTarget(left, right) {
  return Boolean(left && right && left.window === right.window && left.processId === right.processId);
}

function recorderStartConfig() {
  return {
    language: config.language,
    mode: config.mode,
    selectedInputDeviceId: config.selectedInputDeviceId,
  };
}

function workerLaunchOptions() {
  if (app.isPackaged) {
    // Production uses only the sidecar installed alongside the signed app.
    // Do not fall back to PATH or a user-controlled environment override.
    const runtimeDir = path.join(process.resourcesPath, "durianflow-runtime");
    const command = path.join(runtimeDir, "python", "python.exe");
    const worker = path.join(runtimeDir, "backend", "scripts", "run_worker.py");
    if (!fs.existsSync(command) || !fs.existsSync(worker)) {
      throw new Error("The packaged speech runtime is unavailable");
    }
    return {
      kind: "worker",
      command,
      args: [worker],
      cwd: path.join(runtimeDir, "backend"),
      env: {
        PATH: path.dirname(command),
        PYTHONUNBUFFERED: "1",
        PYTHONUTF8: "1",
      },
    };
  }

  // Source checkouts remain convenient for development, but this branch is
  // never reachable from a packaged release.
  const venvPython = path.join(backendDir, ".venv", "Scripts", "python.exe");
  const command = fs.existsSync(venvPython) ? venvPython : "python";
  return {
    kind: "worker",
    command,
    args: [path.join(backendDir, "scripts", "run_worker.py")],
    cwd: backendDir,
    // Keep the worker environment intentionally small. PATH is needed for the
    // interpreter/native DLL loader; backend configuration is read from .env.
    env: {
      PATH: process.env.PATH || "",
      PYTHONUNBUFFERED: "1",
      PYTHONUTF8: "1",
    },
  };
}

function isCurrentWorkerEvent(event, session = dictationSession) {
  return Boolean(
    session
    && session.generation !== null
    && event?.sessionId === session.id
    && event?.generation === session.generation,
  );
}

function clearFinalizationTimer(session) {
  if (session?.finalizationTimer) {
    clearTimeout(session.finalizationTimer);
    session.finalizationTimer = null;
  }
}

function endDictationSession(session, state) {
  if (!session || dictationSession !== session) return false;
  clearFinalizationTimer(session);
  session.state = state;
  dictationSession = null;
  isRecording = false;
  setTrayMenu();
  return true;
}

function failDictationSession(session, code = "TRANSCRIPTION_FAILED") {
  if (!endDictationSession(session, "failed")) return;
  securityLog("dictation_session_failed", { code });
  showStatus("error", "Transcription failed", true);
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    recorderWindow.webContents.send("dictation:error", { code, message: "Transcription failed" });
  }
}

function armFinalizationTimeout(session) {
  clearFinalizationTimer(session);
  session.finalizationTimer = setTimeout(() => {
    if (dictationSession !== session || session.state !== "finalizing") return;
    failDictationSession(session, "TRANSCRIPTION_TIMEOUT");
    // A worker that cannot finish a session is no longer trustworthy for the
    // next one.  The supervisor kills the complete process tree on force.
    localWorkerTransport?.shutdown({ force: true }).catch(() => {});
  }, FINALIZATION_TIMEOUT_MS);
}

function forwardWorkerEvent(event) {
  const session = dictationSession;
  if (isCurrentWorkerEvent(event, session)) {
    if (event.type === "final" && ["recording", "stopping", "finalizing"].includes(session.state)) {
      const text = typeof event.text === "string" ? event.text.slice(0, MAX_IPC_STRING_LENGTH) : "";
      if (text) session.finalSegments.push(text);
    } else if (event.type === "error") {
      failDictationSession(session, typeof event.code === "string" ? event.code : "WORKER_FAILURE");
    } else if (event.type === "canceled") {
      endDictationSession(session, "cancelled");
    } else if (
      (event.type === "stopped" || (event.type === "status" && event.status === "stopped"))
      && session.state === "finalizing"
    ) {
      completeDictation(session, session.finalSegments.join(" ")).catch(() => {
        failDictationSession(session, "TRANSCRIPTION_FINALIZATION_FAILED");
      });
    }
  }

  if (!recorderWindow || recorderWindow.isDestroyed()) return;
  if (event.type === "partial" || event.type === "final") {
    recorderWindow.webContents.send("dictation:transcript", event);
  } else if (event.type === "status" || event.type === "ready" || event.type === "stopped" || event.type === "canceled") {
    recorderWindow.webContents.send("dictation:status", event);
  } else if (event.type === "error") {
    recorderWindow.webContents.send("dictation:error", event);
  }
}

function createLocalWorkerTransport() {
  if (localWorkerTransport) {
    return localWorkerTransport;
  }
  localWorkerTransport = createDictationTransport(workerLaunchOptions());
  localWorkerTransport.on("model", (event) => {
    if (recorderWindow && !recorderWindow.isDestroyed()) {
      recorderWindow.webContents.send("dictation:model-state", event);
    }
    if (event.state === "loading") {
      showStatus("transcribing", "Preparing speech model...", true);
    } else if (event.state === "ready") {
      // Replace the sticky loading notice once the model finishes loading.
      // A non-sticky ready status auto-hides after the normal status timeout.
      showStatus("ready", `Ready: ${config.hotkey}`);
    } else if (event.state === "unavailable") {
      showStatus("error", "Speech model is unavailable", true);
    }
  });
  localWorkerTransport.on("event", forwardWorkerEvent);
  localWorkerTransport.on("pressure", () => {
    if (recorderWindow && !recorderWindow.isDestroyed()) {
      recorderWindow.webContents.send("dictation:status", { status: "backpressure" });
    }
  });
  localWorkerTransport.on("error", (error) => {
    const code = error?.code || "WORKER_FAILURE";
    securityLog("worker_failure", { code });
    if (dictationSession) failDictationSession(dictationSession, code);
    showStatus("error", "Transcription worker failed", true);
    if (recorderWindow && !recorderWindow.isDestroyed()) {
      recorderWindow.webContents.send("dictation:error", { code, message: "Transcription worker failed" });
    }
  });
  return localWorkerTransport;
}

async function ensureLocalWorkerReady(signal) {
  const transport = createLocalWorkerTransport();
  if (transport.getState().worker === "stopped") {
    await transport.startWorker();
  }
  const initial = transport.getState();
  if (initial.model === "ready") {
    return initial;
  }
  if (initial.model === "unavailable") {
    throw new Error("Speech model is unavailable");
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      transport.shutdown({ force: true }).catch(() => {});
      cleanup(new Error("Speech model readiness timed out"));
    }, 2 * 60 * 1000);
    const abort = () => cleanup(new Error("Speech model startup canceled"));
    const model = (event) => {
      if (event.state === "ready") cleanup(null, transport.getState());
      if (event.state === "unavailable") cleanup(new Error(event.message || "Speech model is unavailable"));
    };
    const failure = (error) => cleanup(error instanceof Error ? error : new Error("Transcription worker failed"));
    const cleanup = (error, value) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      transport.off("model", model);
      transport.off("error", failure);
      if (error) reject(error); else resolve(value);
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    transport.on("model", model);
    transport.on("error", failure);
  });
}

async function startDictation() {
  if (!recorderWindow || recorderWindow.isDestroyed()) {
    return;
  }
  if (isRecording || isStartingDictation || isCapturingHotkey || dictationSession) {
    return;
  }

  isStartingDictation = true;
  cancelStartingDictation = false;
  const startAbortController = new AbortController();
  dictationStartAbortController = startAbortController;
  setTrayMenu();
  showStatus("transcribing", "Starting speech worker...", true);

  try {
    await ensureLocalWorkerReady(startAbortController.signal);
    if (cancelStartingDictation) {
      return;
    }
    // Capture before microphone recording starts.  Auto-paste is disabled if
    // this cannot be established or changes before completion.
    const foregroundTarget = await captureForegroundTarget();
    if (cancelStartingDictation) return;
    dictationSession = {
      id: randomUUID(),
      generation: null,
      state: "recording",
      foregroundTarget,
      finalSegments: [],
      finalizationTimer: null,
    };
    isRecording = true;
    setTrayMenu();
    showStatus("recording", "Listening...", true);
    recorderWindow.webContents.send("dictation:start", recorderStartConfig());
  } finally {
    const wasCancelled = cancelStartingDictation;
    if (dictationStartAbortController === startAbortController) {
      dictationStartAbortController = null;
    }
    isStartingDictation = false;
    cancelStartingDictation = false;
    setTrayMenu();
    if (wasCancelled && !isRecording) {
      showStatus("ready", `Ready: ${config.hotkey}`);
    }
  }
}

function stopDictation() {
  if (isStartingDictation) {
    cancelStartingDictation = true;
    dictationStartAbortController?.abort();
    return;
  }
  if (!isRecording) {
    return;
  }
  isRecording = false;
  if (dictationSession?.state === "recording") {
    dictationSession.state = "stopping";
  }
  setTrayMenu();
  showStatus("transcribing", "Transcribing...", true);
  recorderWindow.webContents.send("dictation:stop");
}

function toggleDictation() {
  if (isRecording || isStartingDictation) {
    stopDictation();
  } else {
    startDictation();
  }
}

function normalizeTranscript(text) {
  const value = String(text || "").replace(/\r\n/g, "\n");
  const clean = value.includes("\n")
    ? value
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
    : value.replace(/\s+/g, " ").trim();
  if (!clean) {
    return "";
  }
  return config.appendSpace ? `${clean} ` : clean;
}

async function pasteText(text, insertedMessage = "Inserted dictation", expectedTarget = null) {
  const normalized = normalizeTranscript(text);
  if (!normalized) {
    showStatus("ready", "No speech detected");
    return;
  }

  const previousClipboardText = clipboard.readText();
  clipboard.writeText(normalized);

  if (!config.autoPaste) {
    showStatus("ready", "Transcript copied to clipboard");
    return;
  }

  const currentTarget = await captureForegroundTarget();
  if (!sameForegroundTarget(expectedTarget, currentTarget)) {
    showStatus("ready", "Transcript copied; focused app changed");
    return;
  }

  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "[System.Windows.Forms.SendKeys]::SendWait('^v')",
  ].join("; ");

  const pasteProcess = spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", script], {
    windowsHide: true,
    stdio: "ignore",
  });

  let finished = false;
  const restoreClipboard = () => {
    if (clipboard.readText() === normalized) {
      clipboard.writeText(previousClipboardText);
    }
  };
  let pasteTimeout;
  const finishPaste = (message = insertedMessage) => {
    if (finished) {
      return;
    }
    finished = true;
    clearTimeout(pasteTimeout);
    showStatus("ready", message);
    setTimeout(() => {
      restoreClipboard();
    }, 800);
  };

  pasteProcess.on("error", () => {
    clearTimeout(pasteTimeout);
    showStatus("error", "Could not paste; transcript copied");
    finished = true;
  });
  pasteProcess.on("exit", () => finishPaste());
  pasteTimeout = setTimeout(() => {
    if (!finished) {
      finished = true;
      pasteProcess.kill();
      showStatus("error", "Paste timed out; transcript copied");
    }
  }, 2500);
}

function fallbackStatusMessage(result) {
  return ["timeout", "unavailable", "invalid"].includes(result?.status)
    ? "LLM unavailable, inserted transcript"
    : "Inserted dictation";
}

async function completeDictation(session, text) {
  if (dictationSession !== session || session.state !== "finalizing") return;
  session.state = "completing";
  clearFinalizationTimer(session);
  const transcript = text || "";

  const pasteForSession = async (value, message) => {
    if (dictationSession !== session || session.state !== "completing") return;
    await pasteText(value, message, session.foregroundTarget);
    endDictationSession(session, "completed");
  };

  if (!shouldAttemptRefinement(transcript, config)) {
    await pasteForSession(transcript);
    return;
  }

  if (shouldBlockForRefinement(transcript, config)) {
    showStatus("transcribing", "Refining text...", true);
    const result = await refineText(transcript, config);
    await pasteForSession(result.text, fallbackStatusMessage(result));
    return;
  }

  const refinement = refineText(transcript, config);
  const immediate = await Promise.race([
    refinement,
    new Promise((resolve) => setTimeout(() => resolve(null), 75)),
  ]);

  if (immediate?.status === "refined") {
    await pasteForSession(immediate.text);
  } else {
    await pasteForSession(transcript);
  }

  refinement.catch(() => {});
}

function trustedHandle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedFileSender(event);
    return handler(event, ...args);
  });
}

trustedHandle("dictation:start/request", async (event, request) => {
  assertRecorderSender(event);
  if (!isRecording || !dictationSession || dictationSession.state !== "recording" || dictationSession.generation !== null) {
    return { status: "rejected_no_session", message: "Dictation is not active" };
  }
  const transport = createLocalWorkerTransport();
  const state = transport.getState();
  if (state.worker !== "ready" || state.model !== "ready") {
    return { status: "rejected_worker_not_ready", message: "Speech worker is not ready" };
  }
  if (!isPlainObject(request)) {
    securityLog("dictation_start_rejected", { reason: "invalid_shape" });
    return { status: "rejected_over_limit", message: "Invalid dictation request" };
  }
  const allowedStartKeys = new Set(["language", "mode", "sampleRate", "channels", "format"]);
  if (Object.keys(request).some((key) => !allowedStartKeys.has(key))) {
    securityLog("dictation_start_rejected", { reason: "unknown_field" });
    return { status: "rejected_over_limit", message: "Invalid dictation request" };
  }
  const payload = request;
  const sampleRate = Number(payload.sampleRate);
  const channels = Number(payload.channels);
  if (typeof payload.language !== "undefined" && (typeof payload.language !== "string" || payload.language.length > 32)) {
    return { status: "rejected_over_limit", message: "Invalid dictation language" };
  }
  if (!["fast", "accurate"].includes(payload.mode)) {
    return { status: "rejected_over_limit", message: "Invalid dictation mode" };
  }
  const mode = payload.mode;
  if (sampleRate !== 16000 || channels !== 1 || payload.format !== "pcm_s16le") {
    return { status: "rejected_over_limit", message: "Expected mono 16 kHz PCM16 audio" };
  }
  try {
    const session = transport.start({
      sessionId: dictationSession.id,
      sampleRate,
      channels,
      format: "pcm_s16le",
      language: payload.language ? String(payload.language).slice(0, 32) : null,
      mode,
    });
    dictationSession.generation = session.generation;
    return { status: "accepted", ...session };
  } catch (error) {
    securityLog("dictation_start_failed", { code: error?.code || "UNKNOWN" });
    return { status: "rejected_no_session", message: "Could not start dictation" };
  }
});

trustedHandle("dictation:audio", (event, audio) => {
  assertRecorderSender(event);
  if (!localWorkerTransport || !dictationSession || dictationSession.state !== "recording") {
    return { status: "rejected_worker_not_ready" };
  }
  if (!(audio instanceof ArrayBuffer)) {
    return { status: "rejected_over_limit", message: "Audio must be an ArrayBuffer" };
  }
  // Check before Buffer.from so a compromised renderer cannot force a large
  // allocation in the main process.
  if (!audio.byteLength || audio.byteLength > MAX_AUDIO_FRAME_BYTES || audio.byteLength % 2 !== 0) {
    securityLog("audio_rejected", { bytes: audio.byteLength || 0 });
    return { status: "rejected_over_limit", message: "Invalid PCM audio frame" };
  }
  try {
    return localWorkerTransport.sendAudio(Buffer.from(audio))
      ? { status: "accepted" }
      : { status: "rejected_backpressure" };
  } catch (error) {
    return {
      status: error?.code === "WORKER_BACKPRESSURE" ? "rejected_backpressure" : "rejected_no_session",
      message: "Could not send audio",
    };
  }
});

trustedHandle("dictation:stop", (event) => {
  assertRecorderSender(event);
  if (!localWorkerTransport || !dictationSession || !["recording", "stopping"].includes(dictationSession.state)) {
    return { status: "rejected_no_session" };
  }
  try {
    const accepted = localWorkerTransport.stop();
    if (!accepted) return { status: "rejected_no_session" };
    dictationSession.state = "finalizing";
    armFinalizationTimeout(dictationSession);
    return { status: "accepted" };
  } catch (error) {
    securityLog("dictation_stop_failed", { code: error?.code || "UNKNOWN" });
    return { status: "rejected_stopping", message: "Could not stop dictation" };
  }
});

trustedHandle("dictation:cancel", (event) => {
  assertRecorderSender(event);
  if (!localWorkerTransport || !dictationSession) return { status: "rejected_no_session" };
  const session = dictationSession;
  if (["cancelled", "completed", "failed"].includes(session.state)) return { status: "rejected_no_session" };
  try {
    const accepted = localWorkerTransport.cancel();
    if (!accepted) return { status: "rejected_no_session" };
    endDictationSession(session, "cancelled");
    showStatus("ready", `Ready: ${config.hotkey}`);
    return { status: "accepted" };
  } catch (error) {
    securityLog("dictation_cancel_failed", { code: error?.code || "UNKNOWN" });
    return { status: "rejected_canceling", message: "Could not cancel dictation" };
  }
});

trustedHandle("dictation:state:get", (event) => {
  assertRecorderSender(event);
  const state = localWorkerTransport ? localWorkerTransport.getState() : { worker: "stopped", model: "unknown", session: null };
  return { worker: state.worker, model: state.model, session: dictationSession ? { state: dictationSession.state } : null };
});

trustedHandle("config:get", (event) => {
  assertSettingsSender(event);
  return { config: publicConfig(), appVersion: app.getVersion() };
});

trustedHandle("hotkey-capture:start", (event) => {
  assertPrimarySettingsSender(event);
  isCapturingHotkey = true;
  stopShortcutRegistration();
  return { ok: true };
});

trustedHandle("hotkey-capture:end", (event) => {
  assertPrimarySettingsSender(event);
  return endHotkeyCapture();
});

trustedHandle("config:save", async (event, nextConfig) => {
  assertSettingsSender(event);
  const previousConfig = { ...config };
  let patch;
  try {
    patch = validateConfigPatch(nextConfig);
  } catch {
    return { ok: false, error: "INVALID_CONFIG", config: publicConfig() };
  }
  const next = sanitizeConfig(mergeConfigPatch(config, patch));
  const shortcutChanged = next.hotkey !== config.hotkey || next.inputBehavior !== config.inputBehavior;
  const hotkeySafe = isSafeAccelerator(next.hotkey);

  config = next;
  let hotkeyRegistered = hotkeySafe;
  let restoredHotkeyRegistered = true;
  if (shortcutChanged) {
    hotkeyRegistered = hotkeySafe ? await applyShortcutRegistration() : false;
    if (!hotkeyRegistered) {
      config = previousConfig;
      restoredHotkeyRegistered = await applyShortcutRegistration();
    }
  }

  saveConfig();
  preloadConfiguredLlmInBackground(config);
  notifyConfigUpdated();
  setTrayMenu();
  showStatus(
    hotkeyRegistered ? "ready" : "error",
    hotkeyRegistered
      ? "Settings saved"
      : restoredHotkeyRegistered
        ? "Hotkey unavailable; previous shortcut restored"
        : "Could not register a hotkey",
    !hotkeyRegistered,
  );

  return {
    ok: true,
    config: publicConfig(),
    hotkeyRegistered,
    restoredHotkeyRegistered,
  };
});

trustedHandle("ollama:models", async (event, baseUrl) => {
  assertSettingsSender(event);
  if (typeof baseUrl !== "string" || baseUrl.length > 2_048) {
    return [];
  }
  const url = sanitizeHttpServiceUrl(baseUrl, config.ollamaServerUrl, config.allowRemoteLlm);
  return listOllamaModels(url);
});

trustedHandle("llm:preload", async (event, nextConfig) => {
  assertSettingsSender(event);
  let patch;
  try {
    patch = validateConfigPatch(nextConfig);
  } catch {
    return { ok: false, status: "invalid_config" };
  }
  const merged = mergeConfigPatch(config, patch);
  merged.llmEnabled = Boolean(patch.llmEnabled);
  const preloadConfig = sanitizeConfig(merged);
  return preloadConfiguredLlm(preloadConfig, { force: true });
});

trustedHandle("advanced-settings:open", (event) => {
  assertPrimarySettingsSender(event);
  openAdvancedSettingsWindow();
  return { ok: true };
});

trustedHandle("app-status:get", async (event) => {
  assertSettingsSender(event);
  const worker = localWorkerTransport?.getState();
  const status = { ok: worker?.worker === "ready" && worker?.model === "ready", state: worker?.model || "stopped", message: "Local worker" };
  return {
    isRecording,
    isStartingDictation,
    worker,
    workerStatus: status,
    llm: llmStatus(config),
    gpuMemory: await gpuMemoryStatus(),
    version: app.getVersion(),
    platform: process.platform,
  };
});

trustedHandle("settings-window:fit", (event, size) => {
  assertPrimarySettingsSender(event);
  if (!isPlainObject(size)) return null;
  return fitSettingsWindowToContent({
    width: Number(size.width),
    height: Number(size.height),
  });
});

app.whenReady().then(async () => {
  loadConfig();
  saveConfig();
  Menu.setApplicationMenu(null);

  app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

  createRecorderWindow();
  createStatusWindow();
  createSettingsWindow();
  installPermissionPolicy(require("electron").session.defaultSession, () => [recorderWindow, settingsWindow]);

  tray = new Tray(createTrayIcon());
  tray.setToolTip(PRODUCT_NAME);
  tray.on("double-click", openSettingsWindow);
  setTrayMenu();

  const hotkeyRegistered = await applyShortcutRegistration();
  ensureLocalWorkerReady().catch((error) => {
    showStatus("error", error?.message || "Could not start speech worker", true);
  });
  preloadConfiguredLlmInBackground(config);
  if (hotkeyRegistered) {
    showStatus("ready", `Ready: ${config.hotkey}`);
  }
});

app.on("window-all-closed", () => {});

app.on("will-quit", () => {
  stopShortcutRegistration();
  if (localWorkerTransport) {
    // Electron cannot await will-quit handlers, but an orderly shutdown is
    // attempted first and the supervisor enforces its timeout.
    localWorkerTransport.shutdown().catch(() => {});
  }
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("activate", () => {
  if (!isQuitting) {
    showStatus("ready", `${PRODUCT_NAME} is running`);
  }
});
