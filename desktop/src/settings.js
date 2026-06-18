const form = document.getElementById("settings-form");
const formMessage = document.getElementById("form-message");
const versionMessage = document.getElementById("version-message");
const testBackendButton = document.getElementById("test-backend");
const testMicButton = document.getElementById("test-mic");
const saveButton = document.getElementById("save-settings");
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
const gpuMemoryValue = document.getElementById("gpu-memory-value");
const gpuMemoryMeter = document.getElementById("gpu-memory-meter");

const fields = {
  language: document.getElementById("language"),
  selectedInputDeviceId: deviceSelect,
  autoPaste: document.getElementById("autoPaste"),
  appendSpace: document.getElementById("appendSpace"),
};

let currentConfig = null;
let savedSnapshot = "";
let recordedHotkey = "";
let hotkeyBeforeCapture = "";
let isRecordingHotkey = false;
let micTestCleanup = null;
let resizeTimer = null;

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
      window.openflow.fitSettingsWindow({ width, height });
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
    status.state === "ready" ? "ok" : "",
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

function setMemoryStatus(memory) {
  setMemoryGauge(gpuMemoryCard, gpuMemoryValue, gpuMemoryMeter, memory, "GPU unavailable");
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
  testBackendButton.disabled = disabled;
  testMicButton.disabled = disabled;
  advancedSettingsButton.disabled = disabled;
  saveButton.disabled = disabled || !isDirty();
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
  saveButton.disabled = !dirty || isRecordingHotkey;
  if (dirty) {
    setMessage("Unsaved changes");
  } else {
    setMessage("No unsaved changes", "ok");
  }
  requestWindowFit();
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
    setState(recordingState, status.isRecording ? "Listening" : "Idle", status.isRecording ? "ok" : "");

    if (status.backend.ok) {
      setState(backendState, status.backend.message || "Running", "ok");
      setState(
        modelState,
        status.backend.modelLoaded
          ? `${status.backend.modelName} (${status.backend.device}/${status.backend.computeType})`
          : "Loading",
        status.backend.modelLoaded ? "ok" : "",
      );
    } else {
      setState(backendState, status.backend.message || "Offline", "error");
      setState(modelState, "Unavailable", "error");
    }

    setLlmStatus(status.llm);
    setMemoryStatus(status.gpuMemory);
  } catch {
    setState(backendState, "Unknown", "error");
    setState(modelState, "Unknown", "error");
    setState(llmState, "Unknown", "error");
    setMemoryStatus(null);
  }
}

async function loadSettings() {
  setFormDisabled(true);
  setMessage("Loading");

  const response = await window.openflow.getConfig();
  versionMessage.textContent = `Version ${response.appVersion || "0.1.0"}`;
  writeFormConfig(response.config, true);
  await loadDevices(response.config.selectedInputDeviceId);
  await refreshAppStatus();

  setFormDisabled(false);
  updateDirtyState();
  requestWindowFit();
}

function setHotkeyCaptureControlsDisabled(disabled) {
  form.classList.toggle("capturing", disabled);
  for (const element of Object.values(fields)) {
    element.disabled = disabled;
  }
  for (const element of form.querySelectorAll("input[name='mode'], input[name='inputBehavior']")) {
    element.disabled = disabled;
  }
  testBackendButton.disabled = disabled;
  testMicButton.disabled = disabled;
  advancedSettingsButton.disabled = disabled;
  saveButton.disabled = true;
  recordHotkeyButton.classList.toggle("hidden", disabled);
  cancelHotkeyButton.classList.toggle("hidden", !disabled);
}

async function beginHotkeyRecording() {
  if (isRecordingHotkey) {
    return;
  }
  await window.openflow.beginHotkeyCapture();
  hotkeyBeforeCapture = recordedHotkey;
  isRecordingHotkey = true;
  setHotkeyCaptureControlsDisabled(true);
  hotkeyButton.classList.add("recording");
  hotkeyValue.textContent = "Press a shortcut";
  setMessage("Recording hotkey. Press Esc to cancel.");
  hotkeyButton.focus();
}

async function endHotkeyRecording() {
  isRecordingHotkey = false;
  setHotkeyCaptureControlsDisabled(false);
  hotkeyButton.classList.remove("recording");
  await window.openflow.endHotkeyCapture();
  updateDirtyState();
}

async function handleCapturedHotkey(accelerator) {
  if (!isSafeAccelerator(accelerator)) {
    setMessage("Use a modifier shortcut, or a function key such as F8.", "error");
    return;
  }

  setRecordedHotkey(accelerator);
  await endHotkeyRecording();
}

async function testMicrophone() {
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

    const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    const source = audioContext.createMediaStreamSource(stream);
    const data = new Uint8Array(analyser.frequencyBinCount);
    source.connect(analyser);

    let stopped = false;
    micTestCleanup = () => {
      stopped = true;
      source.disconnect();
      for (const track of stream.getTracks()) {
        track.stop();
      }
      audioContext.close();
      micMeter.style.width = "0%";
      micTestCleanup = null;
    };

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
      if (micTestCleanup) {
        micTestCleanup();
        setState(micState, "Ready", "ok");
      }
    }, 5000);
  } catch {
    setState(micState, "Permission needed", "error");
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

form.addEventListener("input", updateDirtyState);
form.addEventListener("change", updateDirtyState);

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!isSafeAccelerator(recordedHotkey)) {
    setMessage("Choose a safer hotkey before saving.", "error");
    return;
  }

  setFormDisabled(true);
  setMessage("Saving");

  try {
    const response = await window.openflow.saveConfig(readFormConfig());
    writeFormConfig(response.config, response.hotkeyRegistered);
    setMessage(
      response.hotkeyRegistered ? "No unsaved changes" : "Hotkey unavailable",
      response.hotkeyRegistered ? "ok" : "error",
    );
  } catch (error) {
    setMessage(error.message || "Save failed", "error");
  } finally {
    setFormDisabled(false);
    updateDirtyState();
  }
});

testBackendButton.addEventListener("click", async () => {
  testBackendButton.disabled = true;
  setMessage("Testing backend");

  try {
    const result = await window.openflow.testBackend(currentConfig?.healthUrl);
    setState(backendState, result.message || (result.ok ? "Backend running" : "Backend offline"), result.ok ? "ok" : "error");
    setMessage(result.ok ? "Backend online" : "Backend offline", result.ok ? "ok" : "error");
  } catch {
    setState(backendState, "Backend offline", "error");
    setMessage("Backend offline", "error");
  } finally {
    testBackendButton.disabled = false;
  }
});

testMicButton.addEventListener("click", testMicrophone);

advancedSettingsButton.addEventListener("click", () => {
  window.openflow.openAdvancedSettings().catch((error) => {
    setMessage(error.message || "Could not open advanced settings", "error");
  });
});

window.openflow.onConfigUpdated((nextConfig) => {
  writeFormConfig(nextConfig, true);
});
window.openflow.onLlmStatusUpdated((status) => {
  setLlmStatus(status);
});
window.openflow.onRemeasureSettingsWindow(requestWindowFit);

loadSettings();
setInterval(refreshAppStatus, 5000);
