const DEFAULT_ADVANCED = {
  backendUrl: "ws://localhost:8000/v1/transcribe",
  healthUrl: "http://localhost:8000/health",
  autoStartBackend: true,
  llmEnabled: false,
  llmProvider: "llamacpp",
  llmServerUrl: "http://localhost:8080/v1/chat/completions",
  llmModel: "local",
  ollamaServerUrl: "http://localhost:11434",
  ollamaModel: "",
  llmMode: "grammar",
  llmLatencyBudgetMs: 700,
  llmMaxBlockingChars: 250,
};

const form = document.getElementById("advanced-form");
const formMessage = document.getElementById("form-message");
const versionMessage = document.getElementById("version-message");
const saveButton = document.getElementById("save-settings");
const resetAdvancedButton = document.getElementById("reset-advanced");
const testBackendButton = document.getElementById("test-backend");
const refreshOllamaModelsButton = document.getElementById("refresh-ollama-models");

const fields = {
  backendUrl: document.getElementById("backendUrl"),
  healthUrl: document.getElementById("healthUrl"),
  autoStartBackend: document.getElementById("autoStartBackend"),
  llmEnabled: document.getElementById("llmEnabled"),
  llmProvider: document.getElementById("llmProvider"),
  llmServerUrl: document.getElementById("llmServerUrl"),
  llmModel: document.getElementById("llmModel"),
  ollamaServerUrl: document.getElementById("ollamaServerUrl"),
  ollamaModel: document.getElementById("ollamaModel"),
  llmMode: document.getElementById("llmMode"),
  llmLatencyBudgetMs: document.getElementById("llmLatencyBudgetMs"),
  llmMaxBlockingChars: document.getElementById("llmMaxBlockingChars"),
};

let currentConfig = null;
let savedSnapshot = "";
let llmPreloadGeneration = 0;

function setMessage(message, type = "") {
  formMessage.textContent = message;
  formMessage.className = `message ${type}`.trim();
}

function setFormDisabled(disabled) {
  for (const element of Object.values(fields)) {
    element.disabled = disabled;
  }
  saveButton.disabled = disabled || !isDirty();
  resetAdvancedButton.disabled = disabled;
  testBackendButton.disabled = disabled;
  refreshOllamaModelsButton.disabled = disabled;
}

function readAdvancedConfig() {
  return {
    ...currentConfig,
    backendUrl: fields.backendUrl.value.trim(),
    healthUrl: fields.healthUrl.value.trim(),
    autoStartBackend: fields.autoStartBackend.checked,
    llmEnabled: fields.llmEnabled.checked,
    llmProvider: fields.llmProvider.value,
    llmServerUrl: fields.llmServerUrl.value.trim(),
    llmModel: fields.llmModel.value.trim(),
    ollamaServerUrl: fields.ollamaServerUrl.value.trim(),
    ollamaModel: fields.ollamaModel.value.trim(),
    llmMode: fields.llmMode.value,
    llmLatencyBudgetMs: Number(fields.llmLatencyBudgetMs.value),
    llmMaxBlockingChars: Number(fields.llmMaxBlockingChars.value),
  };
}

function snapshotConfig(config) {
  return JSON.stringify({
    backendUrl: config.backendUrl,
    healthUrl: config.healthUrl,
    autoStartBackend: Boolean(config.autoStartBackend),
    llmEnabled: Boolean(config.llmEnabled),
    llmProvider: config.llmProvider,
    llmServerUrl: config.llmServerUrl,
    llmModel: config.llmModel,
    ollamaServerUrl: config.ollamaServerUrl,
    ollamaModel: config.ollamaModel,
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
  saveButton.disabled = !dirty;
  setMessage(dirty ? "Unsaved changes" : "No unsaved changes", dirty ? "" : "ok");
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
  fields.backendUrl.value = config.backendUrl || DEFAULT_ADVANCED.backendUrl;
  fields.healthUrl.value = config.healthUrl || DEFAULT_ADVANCED.healthUrl;
  fields.autoStartBackend.checked = Boolean(config.autoStartBackend);
  fields.llmEnabled.checked = Boolean(config.llmEnabled);
  fields.llmProvider.value = config.llmProvider || DEFAULT_ADVANCED.llmProvider;
  fields.llmServerUrl.value = config.llmServerUrl || DEFAULT_ADVANCED.llmServerUrl;
  fields.llmModel.value = config.llmModel || DEFAULT_ADVANCED.llmModel;
  fields.ollamaServerUrl.value = config.ollamaServerUrl || DEFAULT_ADVANCED.ollamaServerUrl;
  setOllamaModelOptions([], config.ollamaModel || DEFAULT_ADVANCED.ollamaModel);
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
      updateDirtyState();
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

form.addEventListener("input", updateDirtyState);
form.addEventListener("change", updateDirtyState);

fields.llmProvider.addEventListener("change", () => {
  syncLlmProviderFields();
  if (fields.llmProvider.value === "ollama") {
    refreshOllamaModels({ silent: true });
    preloadSelectedOllamaModel();
  }
  updateDirtyState();
});

fields.llmEnabled.addEventListener("change", () => {
  preloadSelectedOllamaModel();
  updateDirtyState();
});

fields.ollamaModel.addEventListener("change", () => {
  preloadSelectedOllamaModel();
  updateDirtyState();
});

refreshOllamaModelsButton.addEventListener("click", refreshOllamaModels);

testBackendButton.addEventListener("click", async () => {
  testBackendButton.disabled = true;
  setMessage("Testing backend");

  try {
    const result = await window.openflow.testBackend(fields.healthUrl.value.trim());
    setMessage(result.ok ? "Backend online" : result.message || "Backend offline", result.ok ? "ok" : "error");
  } catch {
    setMessage("Backend offline", "error");
  } finally {
    testBackendButton.disabled = false;
  }
});

resetAdvancedButton.addEventListener("click", () => {
  writeFormConfig({ ...currentConfig, ...DEFAULT_ADVANCED });
  updateDirtyState();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setFormDisabled(true);
  setMessage("Saving");

  try {
    const response = await window.openflow.saveConfig(readAdvancedConfig());
    writeFormConfig(response.config, true);
    setMessage(response.hotkeyRegistered ? "No unsaved changes" : "Settings saved, but hotkey unavailable", response.hotkeyRegistered ? "ok" : "error");
  } catch (error) {
    setMessage(error.message || "Save failed", "error");
  } finally {
    setFormDisabled(false);
    updateDirtyState();
  }
});

window.openflow.onConfigUpdated((nextConfig) => {
  writeFormConfig(nextConfig, true);
});

loadSettings();
