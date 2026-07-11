"use strict";

// The recorder window is hidden and never renders rolling transcripts. Keep
// speculative partial inference outside any plausible desktop session so stop
// can proceed directly to finalized utterance transcription instead of first
// draining redundant Whisper passes.
const DESKTOP_PARTIAL_INTERVAL_MS = Number.MAX_SAFE_INTEGER;

function desktopWorkerEnvironment(baseEnvironment = {}) {
  return {
    ...baseEnvironment,
    PARTIAL_INTERVAL_MS: String(DESKTOP_PARTIAL_INTERVAL_MS),
  };
}

module.exports = { DESKTOP_PARTIAL_INTERVAL_MS, desktopWorkerEnvironment };
