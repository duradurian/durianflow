const TARGET_SAMPLE_RATE = 16000;
const CHANNELS = 1;
const MAX_PENDING_AUDIO = 2;

let mediaStream = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let muteNode = null;
let isStopping = false;
let pendingAudio = 0;
let finalSegments = [];
let latestPartial = "";
let stopTimer = null;
let unsubscribe = [];

function downsampleToPcm16(input, inputSampleRate) {
  if (!input.length) return new ArrayBuffer(0);

  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const output = new Int16Array(Math.floor(input.length / ratio));
  for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
    const start = Math.floor(outputIndex * ratio);
    const end = Math.min(Math.floor((outputIndex + 1) * ratio), input.length);
    let sum = 0;
    for (let inputIndex = start; inputIndex < end; inputIndex += 1) sum += input[inputIndex];
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    output[outputIndex] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output.buffer;
}

function dictationApi() {
  const api = window.durianflow && window.durianflow.dictation;
  if (!api) throw new Error("Dictation service is unavailable. Please restart DurianFlow.");
  return api;
}

function transcriptText() {
  return finalSegments.join(" ").trim() || latestPartial.trim();
}

function removeSubscriptions() {
  for (const unsubscribeListener of unsubscribe) unsubscribeListener();
  unsubscribe = [];
}

function stopAudio() {
  if (processorNode) {
    processorNode.disconnect();
    processorNode.onaudioprocess = null;
    processorNode = null;
  }
  if (muteNode) { muteNode.disconnect(); muteNode = null; }
  if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) track.stop();
    mediaStream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
}

function reset() {
  clearTimeout(stopTimer);
  stopTimer = null;
  stopAudio();
  removeSubscriptions();
  pendingAudio = 0;
  isStopping = false;
}

function complete() {
  // Main owns completion and clipboard writes.  The recorder only releases
  // capture resources after the trusted worker reports a terminal status.
  reset();
}

function fail() {
  // The renderer may cancel capture, but it cannot choose a main-process
  // status, error message, or completion text.
  try { dictationApi().cancel().catch(() => {}); } catch {}
  reset();
}

function listen() {
  const api = dictationApi();
  unsubscribe = [
    api.onTranscript((event = {}) => {
      if (event.type === "final" && event.text) finalSegments.push(event.text);
      if (event.type === "partial" && event.text) latestPartial = event.text;
    }),
    api.onStatus((event = {}) => {
      if (event.state === "stopped" || event.status === "stopped") complete();
    }),
    api.onError(() => fail()),
    api.onModelState((event = {}) => {
      if (event.state === "error") fail();
    }),
  ];
}

async function startAudio(config) {
  const audio = { channelCount: CHANNELS, echoCancellation: false, noiseSuppression: true, autoGainControl: true };
  if (config.selectedInputDeviceId) audio.deviceId = { exact: config.selectedInputDeviceId };
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
  audioContext = new AudioContext();
  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  processorNode = audioContext.createScriptProcessor(4096, CHANNELS, CHANNELS);
  muteNode = audioContext.createGain();
  muteNode.gain.value = 0;

  processorNode.onaudioprocess = (event) => {
    if (isStopping || pendingAudio >= MAX_PENDING_AUDIO) return;
    const pcm = downsampleToPcm16(event.inputBuffer.getChannelData(0), audioContext.sampleRate);
    if (!pcm.byteLength) return;
    pendingAudio += 1;
    dictationApi().sendAudio(pcm).then((result) => {
      if (result && result.status && result.status !== "accepted") {
        // The bounded main-process queue rejected this frame. Dropping newest
        // audio is intentional; never let renderer callbacks accumulate.
      }
    }).catch(() => fail())
      .finally(() => { pendingAudio = Math.max(0, pendingAudio - 1); });
  };
  sourceNode.connect(processorNode);
  processorNode.connect(muteNode);
  muteNode.connect(audioContext.destination);
}

async function start(config = {}) {
  if (audioContext || isStopping) return;
  let sessionStarted = false;
  try {
    finalSegments = [];
    latestPartial = "";
    isStopping = false;
    listen();
    // Only pass capture/transcription choices. URLs and credentials remain in main.
    const result = await dictationApi().start({
      language: config.language || null,
      mode: config.mode || "fast",
      sampleRate: TARGET_SAMPLE_RATE,
      channels: CHANNELS,
      format: "pcm_s16le",
    });
    if (result && result.status && result.status !== "accepted") {
      throw new Error(result.message || "Dictation service is not ready");
    }
    sessionStarted = true;
    await startAudio(config);
  } catch (error) {
    if (sessionStarted) {
      // A microphone permission/device failure happens after main has created a
      // session. Release it without delaying the user-visible error.
      dictationApi().cancel().catch(() => {});
    }
    fail();
  }
}

async function stop() {
  if (isStopping) return;
  isStopping = true;
  stopAudio();
  try {
    await dictationApi().stop();
  } catch {
    fail();
    return;
  }
}

window.durianflow.onStartDictation?.(start);
window.durianflow.onStopDictation?.(stop);
