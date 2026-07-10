const form = document.getElementById("settings-form");
const formMessage = document.getElementById("form-message");
const versionMessage = document.getElementById("version-message");
const testMicButton = document.getElementById("test-mic");
const advancedSettingsButton = document.getElementById("advanced-settings");
const deviceSelect = document.getElementById("selectedInputDeviceId");
const hotkeyButton = document.getElementById("hotkey");
const recordHotkeyButton = document.getElementById("record-hotkey");
const cancelHotkeyButton = document.getElementById("cancel-hotkey");
const hotkeyValue = document.getElementById("hotkey-value");
const backendState = document.getElementById("backend-state");
const modelState = document.getElementById("model-state");
const llmState = document.getElementById("llm-state");
const micState = document.getElementById("mic-state");
const recordingState = document.getElementById("recording-state");
const micMeter = document.getElementById("mic-meter");
const gpuMemoryCard = document.getElementById("gpu-memory-card");
const memoryLabel = document.getElementById("memory-label");
const gpuMemoryValue = document.getElementById("gpu-memory-value");
const gpuMemoryMeter = document.getElementById("gpu-memory-meter");

const fields = {
  language: document.getElementById("language"),
  selectedInputDeviceId: deviceSelect,
  autoPaste: document.getElementById("autoPaste"),
  appendSpace: document.getElementById("appendSpace"),
};

const BASIC_CONFIG_KEYS = [
  "hotkey",
  "language",
  "mode",
  "inputBehavior",
  "selectedInputDeviceId",
  "autoPaste",
  "appendSpace",
];

let currentConfig = null;
let savedSnapshot = "";
let recordedHotkey = "";
let hotkeyBeforeCapture = "";
let isRecordingHotkey = false;
let micTestCleanup = null;
let resizeTimer = null;
let autoSaveTimer = null;
let isSaving = false;
let saveQueuedDuringRequest = false;
let formRevision = 0;
let micTestGeneration = 0;

function requestWindowFit() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    requestAnimationFrame(() => {
      const main = document.querySelector("main");
      const width = Math.ceil(Math.max(
        main.scrollWidth,
        document.documentElement.scrollWidth,
        document.body.scrollWidth,
      ));
      const height = Math.ceil(Math.max(
        main.scrollHeight,
        document.documentElement.scrollHeight,
        document.body.scrollHeight,
      ));
      window.openflow.fitSettingsWindow({ width, height }).catch(() => {});
    });
  }, 40);
}

function setMessage(message, type = "") {
  formMessage.textContent = message;
  formMessage.className = `message ${type}`.trim();
}

function setState(element, message, type = "") {
  element.textContent = message;
  element.className = `state-value ${type}`.trim();
}

function setLlmStatus(llmStatus) {
  const status = llmStatus || { state: "off", message: "Off" };
  setState(
    llmState,
    status.message || "Off",
    status.state === "ready" ? "ok" : status.state === "unavailable" ? "error" : "",
  );
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) {
    return "0 GB";
  }
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function setMemoryGauge(card, valueElement, meterElement, memory, unavailableText) {
  const status = memory || { ok: false, used: 0, total: 0, percent: 0 };
  if (!status.ok || !status.total) {
    valueElement.textContent = unavailableText;
    meterElement.style.width = "0%";
    card.classList.add("error");
    return;
  }

  const percent = Math.max(0, Math.min(100, Number(status.percent) || 0));
  valueElement.textContent = `${formatBytes(status.used)} / ${formatBytes(status.total)} (${percent}%)`;
  meterElement.style.width = `${percent}%`;
  card.classList.toggle("error", percent >= 90);
}

function setMemoryStatus(memory, computeDevice = "cpu") {
  const isCpu = computeDevice === "cpu";
  memoryLabel.textContent = isCpu ? "App RAM" : "GPU Memory";
  setMemoryGauge(
    gpuMemoryCard,
    gpuMemoryValue,
    gpuMemoryMeter,
    memory,
    isCpu ? "RAM unavailable" : "GPU unavailable",
  );
}

function setFormDisabled(disabled) {
  for (const element of Object.values(fields)) {
    element.disabled = disabled;
  }
  for (const element of form.querySelectorAll("input[name='mode'], input[name='inputBehavior']")) {
    element.disabled = disabled;
  }
  hotkeyButton.disabled = disabled;
  recordHotkeyButton.disabled = disabled;
  testMicButton.disabled = disabled;
  advancedSettingsButton.disabled = disabled;
}

function selectedMode() {
  return form.querySelector("input[name='mode']:checked")?.value || "fast";
}

function selectedInputBehavior() {
  return form.querySelector("input[name='inputBehavior']:checked")?.value || "toggle";
}

function setSelectedMode(mode) {
  const value = mode === "accurate" ? "accurate" : "fast";
  document.getElementById(`mode-${value}`).checked = true;
}

function setSelectedInputBehavior(inputBehavior) {
  const value = inputBehavior === "hold" ? "hold" : "toggle";
  document.getElementById(`behavior-${value}`).checked = true;
}

function displayHotkey(accelerator) {
  return String(accelerator || "")
    .replaceAll("CommandOrControl", "Ctrl")
    .replaceAll("Command", "Cmd")
    .replaceAll("+", " + ");
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

function setRecordedHotkey(accelerator) {
  recordedHotkey = accelerator;
  hotkeyValue.textContent = displayHotkey(accelerator) || "No shortcut set";
}

function keyFromEvent(event) {
  const key = event.key;
  const code = event.code;

  if (["Control", "Shift", "Alt", "Meta"].includes(key)) {
    return "";
  }
  if (/^Key[A-Z]$/.test(code)) {
    return code.slice(3);
  }
  if (/^Digit[0-9]$/.test(code)) {
    return code.slice(5);
  }
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) {
    return code;
  }

  const namedKeys = {
    Space: "Space",
    Tab: "Tab",
    Enter: "Enter",
    Escape: "Esc",
    Backspace: "Backspace",
    Delete: "Delete",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Backquote: "`",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
  };

  return namedKeys[code] || (key.length === 1 ? key.toUpperCase() : "");
}

function acceleratorFromEvent(event) {
  const parts = [];
  if (event.ctrlKey || event.metaKey) {
    parts.push("CommandOrControl");
  }
  if (event.altKey) {
    parts.push("Alt");
  }
  if (event.shiftKey) {
    parts.push("Shift");
  }

  const key = keyFromEvent(event);
  if (!key) {
    return "";
  }

  parts.push(key);
  return parts.join("+");
}

function readFormConfig() {
  return {
    ...currentConfig,
    hotkey: recordedHotkey,
    language: fields.language.value || null,
    mode: selectedMode(),
    inputBehavior: selectedInputBehavior(),
    selectedInputDeviceId: fields.selectedInputDeviceId.value,
    autoPaste: fields.autoPaste.checked,
    appendSpace: fields.appendSpace.checked,
  };
}

function changedConfigPatch(nextConfig) {
  return Object.fromEntries(
    BASIC_CONFIG_KEYS
      .filter((key) => nextConfig[key] !== currentConfig[key])
      .map((key) => [key, nextConfig[key]]),
  );
}

function snapshotConfig(config) {
  return JSON.stringify({
    hotkey: config.hotkey,
    language: config.language || null,
    mode: config.mode,
    inputBehavior: config.inputBehavior,
    selectedInputDeviceId: config.selectedInputDeviceId || "",
    autoPaste: Boolean(config.autoPaste),
    appendSpace: Boolean(config.appendSpace),
  });
}

function isDirty() {
  return currentConfig ? snapshotConfig(readFormConfig()) !== savedSnapshot : false;
}

function updateDirtyState() {
  const dirty = isDirty();
  if (!isRecordingHotkey && !isSaving) {
    setMessage(dirty ? "Saving changes" : "Saved", dirty ? "" : "ok");
  }
  requestWindowFit();
}

function queueAutoSave({ immediate = false } = {}) {
  clearTimeout(autoSaveTimer);

  if (!currentConfig || isRecordingHotkey || !isDirty()) {
    if (!isSaving) {
      updateDirtyState();
    }
    return;
  }

  if (!form.checkValidity()) {
    setMessage("Complete valid settings before they can be saved.", "error");
    return;
  }

  if (!isSafeAccelerator(recordedHotkey)) {
    setMessage("Choose a safer hotkey before it can be saved.", "error");
    return;
  }

  if (isSaving) {
    saveQueuedDuringRequest = true;
    return;
  }

  setMessage("Saving changes");
  autoSaveTimer = setTimeout(savePendingChanges, immediate ? 0 : 350);
}

async function savePendingChanges() {
  autoSaveTimer = null;
  if (isSaving) {
    saveQueuedDuringRequest = true;
    return;
  }
  if (!currentConfig || isRecordingHotkey || !isDirty()) {
    updateDirtyState();
    return;
  }
  if (!form.checkValidity()) {
    setMessage("Complete valid settings before they can be saved.", "error");
    return;
  }
  if (!isSafeAccelerator(recordedHotkey)) {
    setMessage("Choose a safer hotkey before it can be saved.", "error");
    return;
  }

  const configToSave = readFormConfig();
  const submittedRevision = formRevision;
  let saveCompleted = false;
  let hotkeyRegistered = false;
  isSaving = true;
  saveQueuedDuringRequest = false;
  setMessage("Saving changes");

  try {
    const response = await window.openflow.saveConfig(changedConfigPatch(configToSave));
    saveCompleted = true;
    hotkeyRegistered = response.hotkeyRegistered;

    if (submittedRevision === formRevision) {
      writeFormConfig(response.config, true);
    } else {
      currentConfig = response.config;
      savedSnapshot = snapshotConfig(response.config);
    }

    setMessage(
      response.hotkeyRegistered ? "Saved" : "Hotkey unavailable; previous shortcut restored",
      response.hotkeyRegistered ? "ok" : "error",
    );
  } catch (error) {
    setMessage(error.message || "Could not save changes", "error");
  } finally {
    isSaving = false;
    const shouldSaveLatest = saveQueuedDuringRequest || (saveCompleted && isDirty());
    saveQueuedDuringRequest = false;
    if (shouldSaveLatest) {
      queueAutoSave();
    } else if (saveCompleted && hotkeyRegistered) {
      updateDirtyState();
    }
  }
}

function noteFormChange(options) {
  formRevision += 1;
  updateDirtyState();
  queueAutoSave(options);
}

function writeFormConfig(config, markSaved = false) {
  currentConfig = config;
  setRecordedHotkey(config.hotkey || "");
  fields.language.value = config.language || "";
  setSelectedMode(config.mode || "fast");
  setSelectedInputBehavior(config.inputBehavior || "toggle");
  fields.autoPaste.checked = Boolean(config.autoPaste);
  fields.appendSpace.checked = Boolean(config.appendSpace);
  fields.selectedInputDeviceId.value = config.selectedInputDeviceId || "";

  if (markSaved) {
    savedSnapshot = snapshotConfig(config);
  }
  updateDirtyState();
}

function setDeviceOptions(devices, selectedDeviceId) {
  deviceSelect.replaceChildren();

  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "System default";
  deviceSelect.append(defaultOption);

  for (const device of devices) {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label || `Microphone ${deviceSelect.options.length}`;
    deviceSelect.append(option);
  }

  deviceSelect.value = selectedDeviceId || "";
}

async function loadDevices(selectedDeviceId) {
  try {
    let devices = await navigator.mediaDevices.enumerateDevices();
    let inputs = devices.filter((device) => device.kind === "audioinput");

    if (!inputs.some((device) => device.label)) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      for (const track of stream.getTracks()) {
        track.stop();
      }
      devices = await navigator.mediaDevices.enumerateDevices();
      inputs = devices.filter((device) => device.kind === "audioinput");
    }

    setDeviceOptions(inputs, selectedDeviceId);
    setState(micState, inputs.length ? "Ready" : "No input", inputs.length ? "ok" : "error");
  } catch {
    setDeviceOptions([], selectedDeviceId);
    setState(micState, "Permission needed", "error");
  }
}

async function refreshAppStatus() {
  try {
    const status = await window.openflow.getAppStatus();
    setState(
      recordingState,
      status.isRecording
        ? "Listening"
        : status.isStartingDictation
          ? "Preparing"
          : status.isFinalizingDictation
            ? "Transcribing"
            : "Idle",
      status.isRecording ? "ok" : "",
    );

    if (status.worker?.worker === "ready") {
      setState(backendState, status.workerStatus.message || "Running", "ok");
      const modelReady = status.worker.model === "ready";
      const modelUnavailable = status.worker.model === "unavailable";
      setState(
        modelState,
        modelReady
          ? status.activeVoiceModel || "Active model"
          : modelUnavailable
            ? "Unavailable"
            : `${status.activeVoiceModel || "Model"} loading`,
        modelReady ? "ok" : modelUnavailable ? "error" : "",
      );
    } else {
      setState(backendState, status.workerStatus.message || "Unavailable", "error");
      setState(modelState, "Unavailable", "error");
    }

    setLlmStatus(status.llm);
    setMemoryStatus(status.resourceMemory, status.computeDevice);
  } catch {
    setState(backendState, "Unknown", "error");
    setState(modelState, "Unknown", "error");
    setState(llmState, "Unknown", "error");
    setMemoryStatus(null, "cpu");
  }
}

async function loadSettings() {
  setFormDisabled(true);
  setMessage("Loading");
  try {
    const response = await window.openflow.getConfig();
    versionMessage.textContent = `Version ${response.appVersion || "0.1.0"}`;
    writeFormConfig(response.config, true);
    await loadDevices(response.config.selectedInputDeviceId);
    await refreshAppStatus();
    setFormDisabled(false);
    updateDirtyState();
    if (response.configWarning) setMessage(response.configWarning, "error");
    requestWindowFit();
  } catch (error) {
    setMessage(error.message || "Could not load settings", "error");
    setFormDisabled(false);
  }
}

function setHotkeyCaptureControlsDisabled(disabled) {
  form.classList.toggle("capturing", disabled);
  for (const element of Object.values(fields)) {
    element.disabled = disabled;
  }
  for (const element of form.querySelectorAll("input[name='mode'], input[name='inputBehavior']")) {
    element.disabled = disabled;
  }
  testMicButton.disabled = disabled;
  advancedSettingsButton.disabled = disabled;
  recordHotkeyButton.classList.toggle("hidden", disabled);
  cancelHotkeyButton.classList.toggle("hidden", !disabled);
}

async function beginHotkeyRecording() {
  if (isRecordingHotkey) {
    return;
  }
  hotkeyBeforeCapture = recordedHotkey;
  isRecordingHotkey = true;
  setHotkeyCaptureControlsDisabled(true);
  hotkeyButton.classList.add("recording");
  hotkeyValue.textContent = "Press a shortcut";
  setMessage("Recording hotkey. Press Esc to cancel.");
  hotkeyButton.focus();
  try {
    await window.openflow.beginHotkeyCapture();
  } catch (error) {
    isRecordingHotkey = false;
    setRecordedHotkey(hotkeyBeforeCapture);
    setHotkeyCaptureControlsDisabled(false);
    hotkeyButton.classList.remove("recording");
    throw error;
  }
}

async function endHotkeyRecording() {
  isRecordingHotkey = false;
  setHotkeyCaptureControlsDisabled(false);
  hotkeyButton.classList.remove("recording");
  const result = await window.openflow.endHotkeyCapture();
  if (!result.ok) {
    setMessage(`Could not restore hotkey: ${recordedHotkey}`, "error");
  }
  updateDirtyState();
  return result;
}

async function handleCapturedHotkey(accelerator) {
  if (!isSafeAccelerator(accelerator)) {
    setMessage("Use a modifier shortcut, or a function key such as F8.", "error");
    return;
  }

  setRecordedHotkey(accelerator);
  await endHotkeyRecording();
  noteFormChange({ immediate: true });
}

async function testMicrophone() {
  const generation = ++micTestGeneration;
  let stream = null;
  let audioContext = null;
  if (micTestCleanup) {
    micTestCleanup();
  }

  try {
    setState(micState, "Testing");
    const audio = {
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (fields.selectedInputDeviceId.value) {
      audio.deviceId = { exact: fields.selectedInputDeviceId.value };
    }

    stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    if (generation !== micTestGeneration) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    audioContext = new AudioContext();
    await audioContext.resume();
    if (generation !== micTestGeneration) {
      for (const track of stream.getTracks()) track.stop();
      audioContext.close();
      return;
    }
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    const source = audioContext.createMediaStreamSource(stream);
    const data = new Uint8Array(analyser.frequencyBinCount);
    source.connect(analyser);

    let stopped = false;
    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      source.disconnect();
      for (const track of stream.getTracks()) {
        track.stop();
      }
      audioContext.close();
      micMeter.style.width = "0%";
      if (micTestCleanup === cleanup) micTestCleanup = null;
    };
    micTestCleanup = cleanup;

    const draw = () => {
      if (stopped) {
        return;
      }
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const sample of data) {
        peak = Math.max(peak, Math.abs(sample - 128));
      }
      micMeter.style.width = `${Math.min(100, Math.round((peak / 64) * 100))}%`;
      requestAnimationFrame(draw);
    };
    draw();

    setState(micState, "Mic active", "ok");
    setTimeout(() => {
      if (micTestCleanup === cleanup) {
        cleanup();
        setState(micState, "Ready", "ok");
      }
    }, 5000);
  } catch {
    if (stream) for (const track of stream.getTracks()) track.stop();
    if (audioContext) audioContext.close().catch(() => {});
    if (generation === micTestGeneration) setState(micState, "Permission needed", "error");
  }
}

recordHotkeyButton.addEventListener("click", () => {
  beginHotkeyRecording().catch((error) => {
    setMessage(error.message || "Could not record hotkey", "error");
  });
});

hotkeyButton.addEventListener("click", () => {
  recordHotkeyButton.click();
});

cancelHotkeyButton.addEventListener("click", async () => {
  setRecordedHotkey(hotkeyBeforeCapture);
  await endHotkeyRecording();
  updateDirtyState();
});

window.addEventListener("keydown", async (event) => {
  if (!isRecordingHotkey) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  if (event.key === "Escape") {
    setRecordedHotkey(hotkeyBeforeCapture);
    await endHotkeyRecording();
    return;
  }

  const accelerator = acceleratorFromEvent(event);
  if (accelerator) {
    await handleCapturedHotkey(accelerator);
  }
}, true);

form.addEventListener("input", () => noteFormChange());
form.addEventListener("change", () => noteFormChange());

form.addEventListener("submit", (event) => {
  event.preventDefault();
  queueAutoSave({ immediate: true });
});

testMicButton.addEventListener("click", testMicrophone);

advancedSettingsButton.addEventListener("click", () => {
  window.openflow.openAdvancedSettings().catch((error) => {
    setMessage(error.message || "Could not open advanced settings", "error");
  });
});

window.openflow.onConfigUpdated((nextConfig) => {
  if (!isSaving && !isDirty()) {
    writeFormConfig(nextConfig, true);
  }
});
window.openflow.onHotkeyCaptureCancelled(() => {
  if (!isRecordingHotkey) {
    return;
  }
  setRecordedHotkey(hotkeyBeforeCapture);
  isRecordingHotkey = false;
  setHotkeyCaptureControlsDisabled(false);
  hotkeyButton.classList.remove("recording");
  setMessage("Hotkey recording cancelled.");
  updateDirtyState();
});
window.openflow.onLlmStatusUpdated((status) => {
  setLlmStatus(status);
});
window.openflow.onAppStatusUpdated(refreshAppStatus);
window.openflow.onRemeasureSettingsWindow(requestWindowFit);

loadSettings();
setInterval(refreshAppStatus, 5000);
