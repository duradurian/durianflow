const { app, BrowserWindow, Menu, Tray, clipboard, globalShortcut, ipcMain, nativeImage, screen } = require("electron");
const { execFile, spawn } = require("child_process");
const { randomUUID } = require("crypto");
const fs = require("fs");
const os = require("os");
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

const VOICE_MODELS = Object.freeze([
  "tiny",
  "base",
  "small",
  "medium",
  "large-v3",
  "large-v3-turbo",
  "distil-large-v3",
]);

const DEFAULT_CONFIG = {
  hotkey: "CommandOrControl+Alt+Space",
  language: "en",
  mode: "fast",
  inputBehavior: "toggle",
  selectedInputDeviceId: "",
  autoPaste: true,
  appendSpace: true,
  computeDevice: "cuda",
  fastVoiceModel: "large-v3-turbo",
  accurateVoiceModel: "large-v3-turbo",
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
let localWorkerModelName = null;
let localWorkerDevice = null;
let hotkeyWatcherProcess;
let isRecording = false;
let isStartingDictation = false;
let cancelStartingDictation = false;
let dictationStartAbortController;
let isQuitting = false;
let isCapturingHotkey = false;
let llmLoadState = { key: "", state: "off", provider: "", baseUrl: "", model: "" };
let llmLoadRequestId = 0;
let modelManagementOperation = null;

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
  const source = { ...(nextConfig || {}) };
  for (const key of ["backendUrl", "healthUrl", "backendApiToken", "allowRemoteBackend", "autoStartBackend", "dictationTransport"]) {
    delete source[key];
  }
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
  const voiceModel = (value, fallback) => VOICE_MODELS.includes(value) ? value : fallback;

  return {
    ...DEFAULT_CONFIG,
    ...source,
    hotkey: isSafeAccelerator(hotkey) ? hotkey : DEFAULT_CONFIG.hotkey,
    language: source.language ? String(source.language).trim() : null,
    mode: source.mode === "accurate" ? "accurate" : "fast",
    inputBehavior: source.inputBehavior === "hold" ? "hold" : "toggle",
    selectedInputDeviceId: String(source.selectedInputDeviceId || ""),
    autoPaste: booleanSetting(source.autoPaste, DEFAULT_CONFIG.autoPaste),
    appendSpace: booleanSetting(source.appendSpace, DEFAULT_CONFIG.appendSpace),
    computeDevice: source.computeDevice === "cpu" ? "cpu" : "cuda",
    fastVoiceModel: voiceModel(source.fastVoiceModel, DEFAULT_CONFIG.fastVoiceModel),
    accurateVoiceModel: voiceModel(source.accurateVoiceModel, DEFAULT_CONFIG.accurateVoiceModel),
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

async function appMemoryStatus() {
  let electronBytes = 0;
  try {
    electronBytes = app.getAppMetrics().reduce((total, metric) => (
      total + Math.max(0, Number(metric?.memory?.workingSetSize) || 0) * 1024
    ), 0);
  } catch {
    electronBytes = process.memoryUsage().rss;
  }

  const workerPid = localWorkerTransport?.supervisor?.child?.pid;
  let workerBytes = 0;
  if (Number.isInteger(workerPid) && workerPid > 0 && process.platform === "win32") {
    const output = await execFileText(
      "powershell.exe",
      ["-NoProfile", "-Command", `(Get-Process -Id ${workerPid}).WorkingSet64`],
      1200,
    );
    const parsed = Number(String(output || "").trim());
    if (Number.isFinite(parsed) && parsed > 0) workerBytes = parsed;
  }

  const used = electronBytes + workerBytes;
  const total = os.totalmem();
  return {
    ok: Number.isFinite(used) && used > 0 && Number.isFinite(total) && total > 0,
    used,
    total,
    percent: total > 0 ? Math.round((used / total) * 100) : 0,
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
    throw new Error("Dictation IPC is only available to the recorder window");
  }
}

function recorderStartConfig() {
  return {
    language: config.language,
    mode: config.mode,
    selectedInputDeviceId: config.selectedInputDeviceId,
  };
}

function voiceModelForMode(mode = config.mode) {
  return mode === "accurate" ? config.accurateVoiceModel : config.fastVoiceModel;
}

function requestedVoiceModel(value) {
  return VOICE_MODELS.includes(value) ? value : voiceModelForMode();
}

function workerLaunchOptions(modelName = voiceModelForMode()) {
  const configuredPython = String(process.env.OPENFLOW_PYTHON || "").trim();
  const venvPython = path.join(backendDir, ".venv", "Scripts", "python.exe");
  const command = configuredPython || (fs.existsSync(venvPython) ? venvPython : "python");
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
      MODEL_NAME: modelName,
      DEVICE: config.computeDevice,
      COMPUTE_TYPE: config.computeDevice === "cpu" ? "int8" : "float16",
      // Device selection is explicit: CUDA failures must surface instead of
      // silently retaining a second CPU copy of the model weights.
      FALLBACK_TO_CPU_ON_CUDA_ERROR: "false",
    },
  };
}

function publishSpeechModelUpdate(payload) {
  if (advancedSettingsWindow && !advancedSettingsWindow.isDestroyed()) {
    advancedSettingsWindow.webContents.send("speech-model:update", payload);
  }
}

function notifyAppStatusUpdated() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send("app-status:updated");
  }
}

function runSpeechModelManager(action, options = {}) {
  const exclusive = Boolean(options.exclusive);
  if (exclusive && modelManagementOperation) {
    return Promise.reject(new Error("A speech model operation is already in progress."));
  }

  const modelName = VOICE_MODELS.includes(options.modelName) ? options.modelName : voiceModelForMode();
  const launch = workerLaunchOptions(modelName);
  const args = [path.join(backendDir, "scripts", "manage_model.py"), action, "--json"];
  if (action !== "list" && action !== "cleanup") args.push("--model", modelName);
  if (options.includeRemote) args.push("--include-remote");
  const operation = { action };
  if (exclusive) modelManagementOperation = operation;

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let lastEvent = null;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (modelManagementOperation === operation) modelManagementOperation = null;
      callback(value);
    };
    let child;
    try {
      child = spawn(launch.command, args, {
        cwd: launch.cwd,
        env: launch.env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish(reject, error);
      return;
    }
    const handleLine = (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (!event || typeof event !== "object") return;
        lastEvent = event;
        publishSpeechModelUpdate(event);
      } catch {
        stderr = `${stderr}${line}\n`.slice(-8192);
      }
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || "";
      for (const line of lines) handleLine(line);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8192);
    });
    child.once("error", (error) => finish(reject, error));
    child.once("close", (code) => {
      handleLine(stdout);
      if (code === 0 && lastEvent) {
        finish(resolve, lastEvent);
        return;
      }
      const message = lastEvent?.message || stderr.trim() || `Speech model ${action} failed.`;
      finish(reject, new Error(message));
    });
  });
}

async function stopWorkerForSpeechModelOperation() {
  if (!localWorkerTransport || localWorkerTransport.getState().worker === "stopped") {
    return;
  }
  await localWorkerTransport.shutdown();
}

function forwardWorkerEvent(event) {
  if (!recorderWindow || recorderWindow.isDestroyed()) {
    return;
  }
  if (event.type === "partial" || event.type === "final") {
    recorderWindow.webContents.send("dictation:transcript", event);
  } else if (event.type === "status" || event.type === "ready" || event.type === "stopped" || event.type === "canceled") {
    recorderWindow.webContents.send("dictation:status", event);
  } else if (event.type === "error") {
    recorderWindow.webContents.send("dictation:error", event);
  }
}

function createLocalWorkerTransport(modelName = voiceModelForMode()) {
  if (localWorkerTransport) {
    return localWorkerTransport;
  }
  localWorkerModelName = modelName;
  localWorkerDevice = config.computeDevice;
  localWorkerTransport = createDictationTransport(workerLaunchOptions(modelName));
  localWorkerTransport.on("model", (event) => {
    if (recorderWindow && !recorderWindow.isDestroyed()) {
      recorderWindow.webContents.send("dictation:model-state", event);
    }
    if (event.state === "loading") {
      showStatus("transcribing", "Preparing speech model...", true);
    } else if (event.state === "ready") {
      showStatus("ready", `Ready: ${config.hotkey}`);
    } else if (event.state === "unavailable") {
      showStatus("error", "Speech model is unavailable", true);
    }
    notifyAppStatusUpdated();
  });
  localWorkerTransport.on("event", forwardWorkerEvent);
  localWorkerTransport.on("pressure", () => {
    if (recorderWindow && !recorderWindow.isDestroyed()) {
      recorderWindow.webContents.send("dictation:status", { status: "backpressure" });
    }
  });
  localWorkerTransport.on("error", (error) => {
    const message = error?.message || "Transcription worker failed";
    showStatus("error", message, true);
    if (recorderWindow && !recorderWindow.isDestroyed()) {
      recorderWindow.webContents.send("dictation:error", { code: error?.code || "WORKER_FAILURE", message });
    }
  });
  return localWorkerTransport;
}

async function ensureLocalWorkerReady(signal, modelName = voiceModelForMode()) {
  if (modelManagementOperation) {
    throw new Error("Wait for the speech model operation to finish.");
  }
  if (
    localWorkerTransport
    && (localWorkerModelName !== modelName || localWorkerDevice !== config.computeDevice)
  ) {
    await localWorkerTransport.shutdown();
    localWorkerTransport = null;
    localWorkerModelName = null;
    localWorkerDevice = null;
  }
  const transport = createLocalWorkerTransport(modelName);
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
    const timeout = setTimeout(() => cleanup(new Error("Speech model readiness timed out")), 10 * 60 * 1000);
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
  if (isRecording || isStartingDictation || isCapturingHotkey) {
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

trustedHandle("dictation:start/request", async (event, request) => {
  assertRecorderSender(event);
  if (!isRecording) {
    return { status: "rejected_no_session", message: "Dictation is not active" };
  }
  const transport = createLocalWorkerTransport();
  const state = transport.getState();
  if (state.worker !== "ready" || state.model !== "ready") {
    return { status: "rejected_worker_not_ready", message: "Speech worker is not ready" };
  }
  const payload = request && typeof request === "object" ? request : {};
  const sampleRate = Number(payload.sampleRate);
  const channels = Number(payload.channels);
  const mode = payload.mode === "accurate" ? "accurate" : "fast";
  if (sampleRate !== 16000 || channels !== 1 || payload.format !== "pcm_s16le") {
    return { status: "rejected_over_limit", message: "Expected mono 16 kHz PCM16 audio" };
  }
  try {
    const session = transport.start({
      sessionId: randomUUID(),
      sampleRate,
      channels,
      format: "pcm_s16le",
      language: payload.language ? String(payload.language).slice(0, 32) : null,
      mode,
    });
    return { status: "accepted", ...session };
  } catch (error) {
    return { status: "rejected_no_session", message: error?.message || "Could not start dictation" };
  }
});

trustedHandle("dictation:audio", (event, audio) => {
  assertRecorderSender(event);
  if (!localWorkerTransport) {
    return { status: "rejected_worker_not_ready" };
  }
  if (!(audio instanceof ArrayBuffer)) {
    return { status: "rejected_over_limit", message: "Audio must be an ArrayBuffer" };
  }
  try {
    return localWorkerTransport.sendAudio(Buffer.from(audio))
      ? { status: "accepted" }
      : { status: "rejected_backpressure" };
  } catch (error) {
    return {
      status: error?.code === "WORKER_BACKPRESSURE" ? "rejected_backpressure" : "rejected_no_session",
      message: error?.message,
    };
  }
});

trustedHandle("dictation:stop", (event) => {
  assertRecorderSender(event);
  if (!localWorkerTransport) return { status: "rejected_no_session" };
  try {
    return localWorkerTransport.stop() ? { status: "accepted" } : { status: "rejected_no_session" };
  } catch (error) {
    return { status: "rejected_stopping", message: error?.message };
  }
});

trustedHandle("dictation:cancel", (event) => {
  assertRecorderSender(event);
  if (!localWorkerTransport) return { status: "rejected_no_session" };
  try {
    return localWorkerTransport.cancel() ? { status: "accepted" } : { status: "rejected_no_session" };
  } catch (error) {
    return { status: "rejected_canceling", message: error?.message };
  }
});

trustedHandle("dictation:state:get", (event) => {
  assertRecorderSender(event);
  return localWorkerTransport ? localWorkerTransport.getState() : { worker: "stopped", model: "unknown", session: null };
});

trustedHandle("config:get", (event) => ({
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

trustedHandle("config:save", async (_event, nextConfig) => {
  const previousConfig = { ...config };
  const patch = nextConfig && typeof nextConfig === "object" ? nextConfig : {};
  const next = sanitizeConfig({ ...config, ...patch });
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
  const selectedVoiceModelChanged = (
    next.fastVoiceModel !== previousConfig.fastVoiceModel
    || next.accurateVoiceModel !== previousConfig.accurateVoiceModel
    || next.mode !== previousConfig.mode
    || next.computeDevice !== previousConfig.computeDevice
  );
  if (selectedVoiceModelChanged && !isRecording && !isStartingDictation) {
    ensureLocalWorkerReady(undefined, voiceModelForMode()).catch((error) => {
      showStatus("error", error?.message || "Could not start selected speech model", true);
    });
  }
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

trustedHandle("speech-model:status", async (_event, modelName) => (
  runSpeechModelManager("status", { includeRemote: true, modelName: requestedVoiceModel(modelName) })
));

trustedHandle("speech-model:download", async (_event, modelName) => {
  const selectedModel = requestedVoiceModel(modelName);
  await stopWorkerForSpeechModelOperation();
  const result = await runSpeechModelManager("download", { exclusive: true, modelName: selectedModel });
  try {
    await ensureLocalWorkerReady(undefined, selectedModel);
    return { ...result, message: "Model download complete and ready" };
  } catch (error) {
    return { ...result, message: `Model downloaded, but could not start: ${error?.message || "unknown error"}` };
  }
});

trustedHandle("speech-model:delete", async (_event, modelName) => {
  await stopWorkerForSpeechModelOperation();
  return runSpeechModelManager("delete", { exclusive: true, modelName: requestedVoiceModel(modelName) });
});

trustedHandle("advanced-settings:open", () => {
  openAdvancedSettingsWindow();
  return { ok: true };
});

trustedHandle("app-status:get", async () => {
  const worker = localWorkerTransport?.getState();
  const status = { ok: worker?.worker === "ready" && worker?.model === "ready", state: worker?.model || "stopped", message: "Local worker" };
  return {
    isRecording,
    isStartingDictation,
    worker,
    activeVoiceModel: localWorkerModelName,
    activeComputeDevice: localWorkerDevice,
    computeDevice: config.computeDevice,
    workerStatus: status,
    llm: llmStatus(config),
    resourceMemory: config.computeDevice === "cpu" ? await appMemoryStatus() : await gpuMemoryStatus(),
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

  const hotkeyRegistered = await applyShortcutRegistration();
  await runSpeechModelManager("cleanup").catch((error) => {
    console.warn("Could not clean incomplete speech model downloads:", error?.message || error);
  });
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
