const { app, BrowserWindow, Menu, Tray, clipboard, globalShortcut, ipcMain, nativeImage, screen } = require("electron");
const { execFile, spawn } = require("child_process");
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
const { isLocalHost, sanitizeBackendUrl, sanitizeHttpServiceUrl } = require("./url_policy");
const {
  assertTrustedFileSender,
  installPermissionPolicy,
  isTrustedFileSender,
  registerTrustedWindow,
  secureWebPreferences,
} = require("./window_security");

const DEFAULT_CONFIG = {
  backendUrl: "ws://127.0.0.1:8000/v1/transcribe",
  healthUrl: "http://127.0.0.1:8000/health",
  backendApiToken: "",
  allowRemoteBackend: false,
  hotkey: "CommandOrControl+Alt+Space",
  language: "en",
  mode: "fast",
  inputBehavior: "toggle",
  selectedInputDeviceId: "",
  autoPaste: true,
  appendSpace: true,
  autoStartBackend: true,
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
let backendProcess;
let backendStartPromise;
let hotkeyWatcherProcess;
let isRecording = false;
let isStartingDictation = false;
let cancelStartingDictation = false;
let isQuitting = false;
let isCapturingHotkey = false;
let llmLoadState = { key: "", state: "off", provider: "", baseUrl: "", model: "" };
let llmLoadRequestId = 0;

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
  const booleanSetting = (value, defaultValue) => (typeof value === "boolean" ? value : defaultValue);
  const numericSetting = (value, defaultValue, min, max) => {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return defaultValue;
    }
    return Math.min(max, Math.max(min, Math.round(number)));
  };
  const hotkey = String(nextConfig?.hotkey || DEFAULT_CONFIG.hotkey).trim();
  const llmMode = ["off", "grammar", "format", "enhance"].includes(nextConfig?.llmMode)
    ? nextConfig.llmMode
    : DEFAULT_CONFIG.llmMode;
  const llmProvider = ["llamacpp", "ollama"].includes(nextConfig?.llmProvider)
    ? nextConfig.llmProvider
    : DEFAULT_CONFIG.llmProvider;
  const allowRemoteBackend = booleanSetting(
    nextConfig?.allowRemoteBackend,
    DEFAULT_CONFIG.allowRemoteBackend,
  );
  const allowRemoteLlm = booleanSetting(nextConfig?.allowRemoteLlm, DEFAULT_CONFIG.allowRemoteLlm);

  return {
    ...DEFAULT_CONFIG,
    ...nextConfig,
    backendUrl: sanitizeBackendUrl(nextConfig?.backendUrl, DEFAULT_CONFIG.backendUrl, allowRemoteBackend),
    healthUrl: sanitizeHttpServiceUrl(nextConfig?.healthUrl, DEFAULT_CONFIG.healthUrl, allowRemoteBackend),
    backendApiToken: String(nextConfig?.backendApiToken || "").trim(),
    allowRemoteBackend,
    hotkey: isSafeAccelerator(hotkey) ? hotkey : DEFAULT_CONFIG.hotkey,
    language: nextConfig?.language ? String(nextConfig.language).trim() : null,
    mode: nextConfig?.mode === "accurate" ? "accurate" : "fast",
    inputBehavior: nextConfig?.inputBehavior === "hold" ? "hold" : "toggle",
    selectedInputDeviceId: String(nextConfig?.selectedInputDeviceId || ""),
    autoPaste: booleanSetting(nextConfig?.autoPaste, DEFAULT_CONFIG.autoPaste),
    appendSpace: booleanSetting(nextConfig?.appendSpace, DEFAULT_CONFIG.appendSpace),
    autoStartBackend: booleanSetting(nextConfig?.autoStartBackend, DEFAULT_CONFIG.autoStartBackend),
    llmEnabled: booleanSetting(nextConfig?.llmEnabled, DEFAULT_CONFIG.llmEnabled),
    llmProvider,
    llmServerUrl: sanitizeHttpServiceUrl(nextConfig?.llmServerUrl, DEFAULT_LLM_URL, allowRemoteLlm),
    llmModel: String(nextConfig?.llmModel || DEFAULT_CONFIG.llmModel).trim(),
    ollamaServerUrl: sanitizeHttpServiceUrl(
      nextConfig?.ollamaServerUrl,
      DEFAULT_CONFIG.ollamaServerUrl,
      allowRemoteLlm,
    ),
    ollamaModel: String(nextConfig?.ollamaModel || DEFAULT_CONFIG.ollamaModel).trim(),
    allowRemoteLlm,
    llmMode,
    llmLatencyBudgetMs: numericSetting(
      nextConfig?.llmLatencyBudgetMs,
      DEFAULT_CONFIG.llmLatencyBudgetMs,
      0,
      5000,
    ),
    llmMaxBlockingChars: numericSetting(
      nextConfig?.llmMaxBlockingChars,
      DEFAULT_CONFIG.llmMaxBlockingChars,
      1,
      5000,
    ),
  };
}

function saveConfig() {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
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
    }),
  });

  recorderWindow.loadFile(path.join(__dirname, "recorder.html"));
  registerTrustedWindow(recorderWindow);
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
      window.webContents.send("config:updated", config);
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

function startKeyStateWatcher(mode) {
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

  const watcher = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  hotkeyWatcherProcess = watcher;

  watcher.stdout.on("data", (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.trim() === "DOWN") {
        if (isHoldMode) {
          startDictation();
        } else {
          toggleDictation();
        }
      } else if (line.trim() === "UP" && isHoldMode) {
        stopDictation();
      }
    }
  });

  watcher.on("error", () => {
    if (hotkeyWatcherProcess === watcher) {
      hotkeyWatcherProcess = null;
      showStatus("error", `Could not monitor hotkey: ${config.hotkey}`, true);
    }
  });
  watcher.on("exit", () => {
    if (hotkeyWatcherProcess === watcher) {
      hotkeyWatcherProcess = null;
    }
  });

  return true;
}

function applyShortcutRegistration() {
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
  if (startKeyStateWatcher("toggle")) {
    return true;
  }
  showStatus("error", `Could not register hotkey: ${config.hotkey}`, true);
  return false;
}

function endHotkeyCapture() {
  isCapturingHotkey = false;
  return { ok: applyShortcutRegistration() };
}

function isLocalServiceUrl(value) {
  try {
    return isLocalHost(new URL(value).hostname);
  } catch {
    return false;
  }
}

async function backendStatus(overrideConfig = config) {
  try {
    const headers = {};
    if (overrideConfig.backendApiToken) {
      headers["x-api-token"] = overrideConfig.backendApiToken;
    }
    const response = await fetch(overrideConfig.healthUrl, { headers });
    if (!response.ok) {
      const authFailed = response.status === 401 || response.status === 403;
      return {
        ok: false,
        reachable: true,
        state: authFailed ? "error" : "offline",
        message: authFailed ? "Backend authentication failed" : `HTTP ${response.status}`,
        statusCode: response.status,
        authFailed,
      };
    }
    const body = await response.json();
    const modelLoaded = Boolean(body.model_loaded);
    const modelLoading = Boolean(body.model_loading);
    const modelError = body.model_error ? String(body.model_error) : "";
    return {
      ok: true,
      reachable: true,
      state: modelLoaded ? "ready" : modelError ? "error" : "starting",
      message: modelLoaded ? "Backend running" : modelError || "Backend starting",
      modelLoaded,
      modelLoading,
      modelError,
      modelName: body.model_name,
      device: body.device,
      computeType: body.compute_type,
      activeDevice: body.active_device,
      activeComputeType: body.active_compute_type,
      expectedModelPath: body.expected_model_path,
      modelRetryAfterSeconds: body.model_retry_after_seconds,
    };
  } catch {
    return { ok: false, reachable: false, state: "offline", message: "Backend offline", authFailed: false };
  }
}

async function waitForBackendReady(timeoutMs = 10 * 60 * 1000, shouldCancel = () => false, onWaiting = () => {}) {
  const started = Date.now();
  let lastStatus = { ok: false, state: "offline", message: "Backend offline" };

  while (Date.now() - started < timeoutMs) {
    if (shouldCancel()) {
      return { ...lastStatus, cancelled: true };
    }
    lastStatus = await backendStatus();
    if (lastStatus.ok && lastStatus.modelLoaded) {
      return lastStatus;
    }
    if (lastStatus.ok && lastStatus.modelError) {
      return lastStatus;
    }
    if (lastStatus.authFailed) {
      return lastStatus;
    }
    onWaiting(lastStatus);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return lastStatus;
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

async function startBackendIfNeeded() {
  if (!config.autoStartBackend) {
    return;
  }
  const status = await backendStatus();
  if (status.reachable || status.authFailed || !isLocalServiceUrl(config.healthUrl)) {
    return;
  }
  if (backendStartPromise) {
    return backendStartPromise;
  }
  if (backendProcess) {
    return;
  }

  backendStartPromise = new Promise((resolve) => {
    const python = path.join(backendDir, ".venv", "Scripts", "python.exe");
    const child = fs.existsSync(python)
      ? spawn(python, ["scripts\\run_server.py"], {
        cwd: backendDir,
        windowsHide: true,
        stdio: "ignore",
      })
      : spawn("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(backendDir, "run_backend.ps1"),
      ], {
        cwd: backendDir,
        windowsHide: true,
        stdio: "ignore",
      });

    backendProcess = child;
    child.on("error", (error) => {
      if (backendProcess === child) {
        backendProcess = null;
      }
      showStatus("error", error.message || "Could not start backend");
      resolve();
    });
    child.on("exit", () => {
      if (backendProcess === child) {
        backendProcess = null;
      }
    });
    setTimeout(resolve, 1000);
  });

  try {
    await backendStartPromise;
  } finally {
    backendStartPromise = null;
  }
}

async function startDictation() {
  if (!recorderWindow || recorderWindow.isDestroyed()) {
    return;
  }
  if (isRecording || isStartingDictation || isCapturingHotkey) {
    return;
  }

  isStartingDictation = true;
  cancelStartingDictation = false;
  setTrayMenu();
  showStatus("transcribing", "Starting backend...", true);

  try {
    await startBackendIfNeeded();
    if (cancelStartingDictation) {
      return;
    }

    const status = await waitForBackendReady(
      10 * 60 * 1000,
      () => cancelStartingDictation,
      (nextStatus) => {
        if (nextStatus.modelLoading) {
          showStatus("transcribing", `Preparing ${nextStatus.modelName || "speech model"}...`, true);
        } else if (nextStatus.reachable) {
          showStatus("transcribing", "Starting backend...", true);
        }
      },
    );
    if (status.cancelled || cancelStartingDictation) {
      return;
    }
    if (!status.ok || !status.modelLoaded) {
      showStatus("error", status.modelError || status.message || "Backend is not ready");
      return;
    }

    isRecording = true;
    setTrayMenu();
    showStatus("recording", "Listening...", true);
    recorderWindow.webContents.send("dictation:start", config);
  } finally {
    const wasCancelled = cancelStartingDictation;
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
    return;
  }
  if (!isRecording) {
    return;
  }
  isRecording = false;
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

function pasteText(text, insertedMessage = "Inserted dictation") {
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

async function completeDictation(text) {
  isRecording = false;
  setTrayMenu();
  const transcript = text || "";

  if (!shouldAttemptRefinement(transcript, config)) {
    pasteText(transcript);
    return;
  }

  if (shouldBlockForRefinement(transcript, config)) {
    showStatus("transcribing", "Refining text...", true);
    const result = await refineText(transcript, config);
    pasteText(result.text, fallbackStatusMessage(result));
    return;
  }

  const refinement = refineText(transcript, config);
  const immediate = await Promise.race([
    refinement,
    new Promise((resolve) => setTimeout(() => resolve(null), 75)),
  ]);

  if (immediate?.status === "refined") {
    pasteText(immediate.text);
  } else {
    pasteText(transcript);
  }

  refinement.catch(() => {});
}

function trustedOn(channel, handler) {
  ipcMain.on(channel, (event, ...args) => {
    if (!isTrustedFileSender(event)) {
      return;
    }
    handler(event, ...args);
  });
}

function trustedHandle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedFileSender(event);
    return handler(event, ...args);
  });
}

trustedOn("dictation:complete", (_event, payload) => {
  completeDictation(payload?.text || "").catch(() => {
    pasteText(payload?.text || "", "LLM unavailable, inserted transcript");
  });
});

trustedOn("dictation:error", (_event, payload) => {
  isRecording = false;
  setTrayMenu();
  showStatus("error", payload?.message || "Dictation failed");
});

trustedOn("dictation:status", (_event, payload) => {
  if (payload?.message) {
    showStatus(payload.state || "ready", payload.message, payload.sticky);
  }
});

trustedHandle("config:get", () => ({
  config,
  configPath: configPath(),
  appVersion: app.getVersion(),
}));

trustedHandle("hotkey-capture:start", () => {
  isCapturingHotkey = true;
  stopShortcutRegistration();
  return { ok: true };
});

trustedHandle("hotkey-capture:end", () => {
  return endHotkeyCapture();
});

trustedHandle("config:save", (_event, nextConfig) => {
  const previousConfig = { ...config };
  const next = sanitizeConfig(nextConfig);
  const shortcutChanged = next.hotkey !== config.hotkey || next.inputBehavior !== config.inputBehavior;
  const hotkeySafe = isSafeAccelerator(nextConfig?.hotkey);

  config = next;
  let hotkeyRegistered = hotkeySafe;
  let restoredHotkeyRegistered = true;
  if (shortcutChanged) {
    hotkeyRegistered = hotkeySafe && applyShortcutRegistration();
    if (!hotkeyRegistered) {
      config = previousConfig;
      restoredHotkeyRegistered = applyShortcutRegistration();
    }
  }

  saveConfig();
  preloadConfiguredLlmInBackground(config, { force: true });
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
    config,
    configPath: configPath(),
    hotkeyRegistered,
    restoredHotkeyRegistered,
  };
});

trustedHandle("backend:test", async (_event, nextConfig) => {
  const testConfig = sanitizeConfig({
    ...config,
    ...(typeof nextConfig === "object" ? nextConfig : { healthUrl: nextConfig }),
  });
  return backendStatus(testConfig);
});

trustedHandle("ollama:models", async (_event, baseUrl) => {
  const url = sanitizeHttpServiceUrl(baseUrl, config.ollamaServerUrl, config.allowRemoteLlm);
  return listOllamaModels(url);
});

trustedHandle("llm:preload", async (_event, nextConfig) => {
  const preloadConfig = sanitizeConfig({
    ...config,
    ...nextConfig,
    llmEnabled: Boolean(nextConfig?.llmEnabled),
  });
  return preloadConfiguredLlm(preloadConfig, { force: true });
});

trustedHandle("advanced-settings:open", () => {
  openAdvancedSettingsWindow();
  return { ok: true };
});

trustedHandle("app-status:get", async () => {
  const status = await backendStatus();
  return {
    isRecording,
    isStartingDictation,
    isBackendProcessManaged: Boolean(backendProcess),
    backend: status,
    llm: llmStatus(config),
    gpuMemory: await gpuMemoryStatus(),
    version: app.getVersion(),
    platform: process.platform,
  };
});

trustedHandle("settings-window:fit", (_event, size) => fitSettingsWindowToContent(size));

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

  const hotkeyRegistered = applyShortcutRegistration();
  await startBackendIfNeeded();
  preloadConfiguredLlmInBackground(config);
  if (hotkeyRegistered) {
    showStatus("ready", `Ready: ${config.hotkey}`);
  }
});

app.on("window-all-closed", () => {});

app.on("will-quit", () => {
  stopShortcutRegistration();
  if (backendProcess) {
    backendProcess.kill();
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
