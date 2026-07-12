"use strict";

const BACKENDS = new Set(["mlx", "cuda", "cpu"]);

class AutoBackendRecovery {
  constructor() {
    this.byModel = new Map();
  }

  record(modelName, backend) {
    const model = String(modelName || "");
    const name = String(backend || "").toLowerCase();
    if (!model || !BACKENDS.has(name)) return false;
    const disabled = this.byModel.get(model) || new Set();
    const changed = !disabled.has(name);
    disabled.add(name);
    this.byModel.set(model, disabled);
    return changed;
  }

  disabledFor(modelName) {
    return [...(this.byModel.get(String(modelName || "")) || [])];
  }

  count(modelName) {
    return this.disabledFor(modelName).length;
  }

  clear(modelName, backend = null) {
    const model = String(modelName || "");
    if (!backend) {
      this.byModel.delete(model);
      return;
    }
    const disabled = this.byModel.get(model);
    if (!disabled) return;
    disabled.delete(String(backend).toLowerCase());
    if (!disabled.size) this.byModel.delete(model);
  }

  clearAll() {
    this.byModel.clear();
  }
}

module.exports = { AutoBackendRecovery };
