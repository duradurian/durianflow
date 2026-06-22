const DEFAULT_ADVANCED = {
  fastVoiceModel: "large-v3-turbo",
  accurateVoiceModel: "large-v3-turbo",
  llmEnabled: false,
  llmProvider: "llamacpp",
  llmServerUrl: "http://localhost:8080/v1/chat/completions",
  llmModel: "local",
  ollamaServerUrl: "http://localhost:11434",
  ollamaModel: "",
  allowRemoteLlm: false,
  llmMode: "grammar",
  llmLatencyBudgetMs: 700,
  llmMaxBlockingChars: 250,
};

const form = document.getElementById("advanced-form");
const formMessage = document.getElementById("form-message");
const versionMessage = document.getElementById("version-message");
const resetAdvancedButton = document.getElementById("reset-advanced");
const refreshOllamaModelsButton = document.getElementById("refresh-ollama-models");
const speechModelSummary = document.getElementById("speech-model-summary");
const speechModelName = document.getElementById("speech-model-name");
const speechModelSize = document.getElementById("speech-model-size");
const speechModelFree = document.getElementById("speech-model-free");
const speechModelProgress = document.getElementById("speech-model-progress");
const speechModelProgressText = document.getElementById("speech-model-progress-text");
const speechModelLocation = document.getElementById("speech-model-location");
const downloadSpeechModelButton = document.getElementById("download-speech-model");
const deleteSpeechModelButton = document.getElementById("delete-speech-model");
const refreshSpeechModelButton = document.getElementById("refresh-speech-model");
const speechModelProfile = document.getElementById("speech-model-profile");

const fields = {
  fastVoiceModel: document.getElementById("fastVoiceModel"),
  accurateVoiceModel: document.getElementById("accurateVoiceModel"),
  llmEnabled: document.getElementById("llmEnabled"),
  llmProvider: document.getElementById("llmProvider"),
  llmServerUrl: document.getElementById("llmServerUrl"),
  llmModel: document.getElementById("llmModel"),
  ollamaServerUrl: document.getElementById("ollamaServerUrl"),
  ollamaModel: document.getElementById("ollamaModel"),
  allowRemoteLlm: document.getElementById("allowRemoteLlm"),
  llmMode: document.getElementById("llmMode"),
  llmLatencyBudgetMs: document.getElementById("llmLatencyBudgetMs"),
  llmMaxBlockingChars: document.getElementById("llmMaxBlockingChars"),
};

const ADVANCED_CONFIG_KEYS = Object.keys(fields);

let currentConfig = null;
let savedSnapshot = "";
let llmPreloadGeneration = 0;
let autoSaveTimer = null;
let isSaving = false;
let saveQueuedDuringRequest = false;
let formRevision = 0;
let speechModelStatus = null;
let speechModelOperation = false;

function setMessage(message, type = "") {
  formMessage.textContent = message;
  formMessage.className = `message ${type}`.trim();
}

function setFormDisabled(disabled) {
  for (const element of Object.values(fields)) {
    element.disabled = disabled;
  }
  resetAdvancedButton.disabled = disabled;
  refreshOllamaModelsButton.disabled = disabled;
  speechModelProfile.disabled = disabled;
  setSpeechModelControlsDisabled(disabled || speechModelOperation);
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let size = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024;
    unit = units[index];
  }
  return `${size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${unit}`;
}

function formatDuration(value) {
  const seconds = Math.max(0, Number(value) || 0);
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}

function setSpeechModelControlsDisabled(disabled) {
  const installed = Boolean(speechModelStatus?.installed);
  const canDelete = Boolean(speechModelStatus?.canDelete);
  downloadSpeechModelButton.disabled = disabled || installed;
  deleteSpeechModelButton.disabled = disabled || !canDelete;
  refreshSpeechModelButton.disabled = disabled;
}

function selectedSpeechModel() {
  return speechModelProfile.value === "accurate"
    ? fields.accurateVoiceModel.value
    : fields.fastVoiceModel.value;
}

function renderSpeechModelStatus(status) {
  if (!status || typeof status !== "object") return;
  speechModelStatus = { ...speechModelStatus, ...status };
  const current = speechModelStatus;
  speechModelName.textContent = current.model || "Configured model";
  speechModelSize.textContent = current.installed
    ? formatBytes(current.sizeBytes)
    : current.downloadedBytes ? `${formatBytes(current.downloadedBytes)} cached` : "Not installed";
  speechModelFree.textContent = formatBytes(current.freeBytes);
  speechModelLocation.textContent = current.path ? `Location: ${current.path}` : "";
  speechModelSummary.textContent = current.message || (current.installed ? "Installed" : "Not installed");
  speechModelSummary.className = `helper ${current.type === "error" ? "error" : ""}`.trim();

  const downloaded = Number(current.downloadedBytes) || 0;
  const total = Number(current.totalBytes) || 0;
  if (total > 0) {
    speechModelProgress.max = total;
    speechModelProgress.value = Math.min(downloaded, total);
  } else {
    speechModelProgress.removeAttribute("value");
  }
  if (current.type === "progress") {
    const pieces = [`${formatBytes(downloaded)} downloaded`];
    if (total > 0) pieces.push(`of ${formatBytes(total)} (${Math.min(100, (downloaded / total) * 100).toFixed(1)}%)`);
    if (current.speedBytesPerSecond) pieces.push(`${formatBytes(current.speedBytesPerSecond)}/s`);
    if (current.elapsedSeconds) pieces.push(formatDuration(current.elapsedSeconds));
    speechModelProgressText.textContent = pieces.join(" · ");
  } else if (current.installed) {
    speechModelProgress.value = 1;
    speechModelProgress.max = 1;
    speechModelProgressText.textContent = `Installed size: ${formatBytes(current.sizeBytes)}`;
  } else {
    speechModelProgressText.textContent = total > 0
      ? `Download size: ${formatBytes(total)}`
      : "Download size will be shown when the model host provides it.";
  }
  setSpeechModelControlsDisabled(speechModelOperation);
}

async function refreshSpeechModelStatus(options = {}) {
  if (!options.silent) speechModelSummary.textContent = "Checking model status…";
  try {
    renderSpeechModelStatus(await window.openflow.getSpeechModelStatus(selectedSpeechModel()));
  } catch (error) {
    renderSpeechModelStatus({ type: "error", message: error.message || "Could not inspect speech model" });
  }
}

async function downloadSpeechModel() {
  speechModelOperation = true;
  setSpeechModelControlsDisabled(true);
  renderSpeechModelStatus({ type: "started", message: "Starting model download", downloadedBytes: 0 });
  try {
    renderSpeechModelStatus(await window.openflow.downloadSpeechModel(selectedSpeechModel()));
  } catch (error) {
    renderSpeechModelStatus({ type: "error", message: error.message || "Model download failed" });
  } finally {
    speechModelOperation = false;
    setSpeechModelControlsDisabled(false);
    refreshSpeechModelStatus({ silent: true });
  }
}

async function deleteSpeechModel() {
  if (!speechModelStatus?.canDelete) return;
  if (!window.confirm(`Delete ${speechModelStatus.model || "the speech model"}? You will need to download it again before dictation can use it.`)) {
    return;
  }
  speechModelOperation = true;
  setSpeechModelControlsDisabled(true);
  renderSpeechModelStatus({ type: "started", message: "Deleting model download" });
  try {
    renderSpeechModelStatus(await window.openflow.deleteSpeechModel(selectedSpeechModel()));
  } catch (error) {
    renderSpeechModelStatus({ type: "error", message: error.message || "Could not delete the model" });
  } finally {
    speechModelOperation = false;
    setSpeechModelControlsDisabled(false);
    refreshSpeechModelStatus({ silent: true });
  }
}

function readAdvancedConfig() {
  const numberValue = (field, fallback) => {
    if (!field.value.trim()) {
      return fallback;
    }
    return Number.isFinite(field.valueAsNumber) ? field.valueAsNumber : fallback;
  };

  return {
    ...currentConfig,
    fastVoiceModel: fields.fastVoiceModel.value,
    accurateVoiceModel: fields.accurateVoiceModel.value,
    llmEnabled: fields.llmEnabled.checked,
    llmProvider: fields.llmProvider.value,
    llmServerUrl: fields.llmServerUrl.value.trim(),
    llmModel: fields.llmModel.value.trim(),
    ollamaServerUrl: fields.ollamaServerUrl.value.trim(),
    ollamaModel: fields.ollamaModel.value.trim(),
    allowRemoteLlm: fields.allowRemoteLlm.checked,
    llmMode: fields.llmMode.value,
    llmLatencyBudgetMs: numberValue(fields.llmLatencyBudgetMs, currentConfig.llmLatencyBudgetMs),
    llmMaxBlockingChars: numberValue(fields.llmMaxBlockingChars, currentConfig.llmMaxBlockingChars),
  };
}

function changedConfigPatch(nextConfig) {
  return Object.fromEntries(
    ADVANCED_CONFIG_KEYS
      .filter((key) => nextConfig[key] !== currentConfig[key])
      .map((key) => [key, nextConfig[key]]),
  );
}

function snapshotConfig(config) {
  return JSON.stringify({
    fastVoiceModel: config.fastVoiceModel,
    accurateVoiceModel: config.accurateVoiceModel,
    llmEnabled: Boolean(config.llmEnabled),
    llmProvider: config.llmProvider,
    llmServerUrl: config.llmServerUrl,
    llmModel: config.llmModel,
    ollamaServerUrl: config.ollamaServerUrl,
    ollamaModel: config.ollamaModel,
    allowRemoteLlm: Boolean(config.allowRemoteLlm),
    llmMode: config.llmMode,
    llmLatencyBudgetMs: Number(config.llmLatencyBudgetMs),
    llmMaxBlockingChars: Number(config.llmMaxBlockingChars),
  });
}

function isDirty() {
  return currentConfig ? snapshotConfig(readAdvancedConfig()) !== savedSnapshot : false;
}

function updateDirtyState() {
  const dirty = isDirty();
  if (!isSaving) {
    setMessage(dirty ? "Saving changes" : "Saved", dirty ? "" : "ok");
  }
}

function queueAutoSave({ immediate = false } = {}) {
  clearTimeout(autoSaveTimer);

  if (!currentConfig || !isDirty()) {
    if (!isSaving) {
      updateDirtyState();
    }
    return;
  }

  if (!form.checkValidity()) {
    setMessage("Complete valid settings before they can be saved.", "error");
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
  if (!currentConfig || !isDirty()) {
    updateDirtyState();
    return;
  }
  if (!form.checkValidity()) {
    setMessage("Complete valid settings before they can be saved.", "error");
    return;
  }

  const configToSave = readAdvancedConfig();
  const submittedRevision = formRevision;
  let saveCompleted = false;
  let hotkeyRegistered = true;
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
      response.hotkeyRegistered ? "Saved" : "Settings saved, but hotkey is unavailable",
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

function syncLlmProviderFields() {
  const provider = fields.llmProvider.value === "ollama" ? "ollama" : "llamacpp";
  document.querySelectorAll("[data-provider-field]").forEach((element) => {
    element.classList.toggle("hidden", element.dataset.providerField !== provider);
  });
}

function setOllamaModelOptions(models, selectedModel = "") {
  const selected = String(selectedModel || "").trim();
  const values = [...new Set([
    selected,
    ...models.map((model) => String(model || "").trim()),
  ].filter(Boolean))].sort((a, b) => a.localeCompare(b));

  fields.ollamaModel.replaceChildren();
  if (!values.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No downloaded models found";
    fields.ollamaModel.append(option);
    return;
  }

  for (const model of values) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    fields.ollamaModel.append(option);
  }
  fields.ollamaModel.value = selected && values.includes(selected) ? selected : values[0];
}

function writeFormConfig(config, markSaved = false) {
  currentConfig = config;
  fields.fastVoiceModel.value = config.fastVoiceModel || DEFAULT_ADVANCED.fastVoiceModel;
  fields.accurateVoiceModel.value = config.accurateVoiceModel || DEFAULT_ADVANCED.accurateVoiceModel;
  fields.llmEnabled.checked = Boolean(config.llmEnabled);
  fields.llmProvider.value = config.llmProvider || DEFAULT_ADVANCED.llmProvider;
  fields.llmServerUrl.value = config.llmServerUrl || DEFAULT_ADVANCED.llmServerUrl;
  fields.llmModel.value = config.llmModel || DEFAULT_ADVANCED.llmModel;
  fields.ollamaServerUrl.value = config.ollamaServerUrl || DEFAULT_ADVANCED.ollamaServerUrl;
  setOllamaModelOptions([], config.ollamaModel || DEFAULT_ADVANCED.ollamaModel);
  fields.allowRemoteLlm.checked = Boolean(config.allowRemoteLlm);
  fields.llmMode.value = config.llmMode || DEFAULT_ADVANCED.llmMode;
  fields.llmLatencyBudgetMs.value = Number(config.llmLatencyBudgetMs ?? DEFAULT_ADVANCED.llmLatencyBudgetMs);
  fields.llmMaxBlockingChars.value = Number(config.llmMaxBlockingChars || DEFAULT_ADVANCED.llmMaxBlockingChars);
  syncLlmProviderFields();

  if (markSaved) {
    savedSnapshot = snapshotConfig(config);
  }
  updateDirtyState();
}

async function loadSettings() {
  setFormDisabled(true);
  setMessage("Loading");

  const response = await window.openflow.getConfig();
  versionMessage.textContent = `Version ${response.appVersion || "0.1.0"}`;
  writeFormConfig(response.config, true);

  setFormDisabled(false);
  updateDirtyState();
  refreshSpeechModelStatus({ silent: true });
  if (fields.llmProvider.value === "ollama") {
    refreshOllamaModels({ silent: true });
  }
}

async function refreshOllamaModels(options = {}) {
  refreshOllamaModelsButton.disabled = true;
  if (!options.silent) {
    setMessage("Scanning Ollama models");
  }

  try {
    const result = await window.openflow.listOllamaModels(fields.ollamaServerUrl.value.trim());
    const previousModel = fields.ollamaModel.value;
    setOllamaModelOptions(result.models || [], previousModel);
    if (fields.ollamaModel.value !== previousModel) {
      noteFormChange({ immediate: true });
      preloadSelectedOllamaModel();
    }
    if (!options.silent) {
      setMessage(result.ok ? `Found ${result.models.length} Ollama model(s)` : result.message || "No Ollama models found", result.ok ? "ok" : "error");
    }
  } catch (error) {
    if (!options.silent) {
      setMessage(error.message || "No Ollama models found", "error");
    }
  } finally {
    refreshOllamaModelsButton.disabled = false;
  }
}

async function preloadSelectedOllamaModel() {
  if (
    !fields.llmEnabled.checked
    || fields.llmProvider.value !== "ollama"
    || !fields.ollamaModel.value.trim()
  ) {
    return;
  }

  const generation = ++llmPreloadGeneration;
  setMessage("Starting LLM");

  try {
    const result = await window.openflow.preloadLlm(readAdvancedConfig());
    if (generation !== llmPreloadGeneration) {
      return;
    }
    setMessage(
      result.state === "ready" ? "LLM ready" : "LLM starting",
      result.state === "ready" ? "ok" : "",
    );
  } catch (error) {
    if (generation === llmPreloadGeneration) {
      setMessage(error.message || "LLM starting", "error");
    }
  }
}

form.addEventListener("input", () => noteFormChange());
form.addEventListener("change", () => noteFormChange());

fields.llmProvider.addEventListener("change", () => {
  syncLlmProviderFields();
  if (fields.llmProvider.value === "ollama") {
    refreshOllamaModels({ silent: true });
    preloadSelectedOllamaModel();
  }
});

fields.llmEnabled.addEventListener("change", () => {
  preloadSelectedOllamaModel();
});

fields.ollamaModel.addEventListener("change", () => {
  preloadSelectedOllamaModel();
});

refreshOllamaModelsButton.addEventListener("click", refreshOllamaModels);
refreshSpeechModelButton.addEventListener("click", () => refreshSpeechModelStatus());
downloadSpeechModelButton.addEventListener("click", downloadSpeechModel);
deleteSpeechModelButton.addEventListener("click", deleteSpeechModel);
speechModelProfile.addEventListener("change", () => {
  speechModelStatus = null;
  refreshSpeechModelStatus();
});
fields.fastVoiceModel.addEventListener("change", () => {
  if (speechModelProfile.value === "fast") {
    speechModelStatus = null;
    refreshSpeechModelStatus({ silent: true });
  }
});
fields.accurateVoiceModel.addEventListener("change", () => {
  if (speechModelProfile.value === "accurate") {
    speechModelStatus = null;
    refreshSpeechModelStatus({ silent: true });
  }
});

resetAdvancedButton.addEventListener("click", () => {
  writeFormConfig({ ...currentConfig, ...DEFAULT_ADVANCED });
  noteFormChange({ immediate: true });
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  queueAutoSave({ immediate: true });
});

window.openflow.onConfigUpdated((nextConfig) => {
  if (!isSaving && !isDirty()) {
    writeFormConfig(nextConfig, true);
  }
});

window.openflow.onSpeechModelUpdate((event) => {
  if (!event?.model || event.model === selectedSpeechModel()) {
    renderSpeechModelStatus(event);
  }
});

loadSettings();
