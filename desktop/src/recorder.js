const TARGET_SAMPLE_RATE = 16000;
const CHANNELS = 1;
const MAX_PENDING_AUDIO = 2;
const MAX_REJECTED_AUDIO_FRAMES = 3;
const STOP_TIMEOUT_MS = 120_000;

let mediaStream = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let muteNode = null;
let isStopping = false;
let isCompleting = false;
let pendingAudio = 0;
let finalSegments = [];
let latestPartial = "";
let stopTimer = null;
let unsubscribe = [];
let lifecycleGeneration = 0;
let isStartingAudio = false;
let rejectedAudioFrames = 0;

function downsampleToPcm16(input, inputSampleRate) {
  if (!input.length) return new ArrayBuffer(0);

  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const output = new Int16Array(Math.max(1, Math.round(input.length / ratio)));
  for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
    let sample;
    if (ratio < 1) {
      const position = outputIndex * ratio;
      const left = Math.min(input.length - 1, Math.floor(position));
      const right = Math.min(input.length - 1, left + 1);
      const fraction = position - left;
      sample = input[left] + (input[right] - input[left]) * fraction;
    } else {
      const start = Math.min(input.length - 1, Math.floor(outputIndex * ratio));
      const end = Math.min(input.length, Math.max(start + 1, Math.floor((outputIndex + 1) * ratio)));
      let sum = 0;
      for (let inputIndex = start; inputIndex < end; inputIndex += 1) sum += input[inputIndex];
      sample = sum / (end - start);
    }
    sample = Math.max(-1, Math.min(1, sample));
    output[outputIndex] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output.buffer;
}

function dictationApi() {
  const api = window.openflow && window.openflow.dictation;
  if (!api) throw new Error("Dictation service is unavailable. Please restart Durianflow.");
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
  lifecycleGeneration += 1;
  clearTimeout(stopTimer);
  stopTimer = null;
  stopAudio();
  removeSubscriptions();
  pendingAudio = 0;
  rejectedAudioFrames = 0;
  isStartingAudio = false;
  isStopping = false;
}

function complete() {
  if (isCompleting) return;
  isCompleting = true;
  const text = transcriptText();
  reset();
  window.openflow.completeDictation(text);
  isCompleting = false;
}

function fail(message) {
  if (isCompleting) return;
  isCompleting = true;
  // Failure may originate in the renderer (for example a rejected IPC call),
  // so ensure a live main-process session does not retain queued audio.
  try { dictationApi().cancel().catch(() => {}); } catch {}
  reset();
  window.openflow.failDictation(message || "Dictation failed");
  isCompleting = false;
}

function listen() {
  const api = dictationApi();
  unsubscribe = [
    api.onTranscript((event = {}) => {
      if (event.type === "final" && event.text) finalSegments.push(event.text);
      if (event.type === "partial" && event.text) latestPartial = event.text;
    }),
    api.onStatus((event = {}) => {
      if (event.type === "stopped") complete();
    }),
    api.onError((event = {}) => fail(event.message || event.code || "Transcription error")),
    api.onModelState((event = {}) => {
      if (event.state === "error" || event.state === "unavailable") {
        fail(event.message || "Transcription model unavailable");
      }
    }),
  ];
}

async function startAudio(config, generation) {
  const audio = { channelCount: CHANNELS, echoCancellation: false, noiseSuppression: true, autoGainControl: true };
  if (config.selectedInputDeviceId) audio.deviceId = { exact: config.selectedInputDeviceId };
  const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
  if (generation !== lifecycleGeneration || isStopping) {
    for (const track of stream.getTracks()) track.stop();
    throw new Error("Dictation startup was canceled");
  }
  mediaStream = stream;
  audioContext = new AudioContext();
  await audioContext.resume();
  if (generation !== lifecycleGeneration || isStopping) {
    stopAudio();
    throw new Error("Dictation startup was canceled");
  }
  if (audioContext.state !== "running") {
    stopAudio();
    throw new Error("Microphone audio could not be started");
  }
  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  processorNode = audioContext.createScriptProcessor(4096, CHANNELS, CHANNELS);
  muteNode = audioContext.createGain();
  muteNode.gain.value = 0;

  processorNode.onaudioprocess = (event) => {
    if (isStopping) return;
    if (pendingAudio >= MAX_PENDING_AUDIO) {
      rejectedAudioFrames += 1;
      if (rejectedAudioFrames >= MAX_REJECTED_AUDIO_FRAMES) {
        fail("Speech worker could not keep up with audio; please try again");
      }
      return;
    }
    const pcm = downsampleToPcm16(event.inputBuffer.getChannelData(0), audioContext.sampleRate);
    if (!pcm.byteLength) return;
    pendingAudio += 1;
    dictationApi().sendAudio(pcm).then((result) => {
      if (generation !== lifecycleGeneration || isStopping) return;
      if (result?.status === "accepted") {
        rejectedAudioFrames = 0;
      } else {
        rejectedAudioFrames += 1;
        if (rejectedAudioFrames >= MAX_REJECTED_AUDIO_FRAMES) {
          fail("Speech worker could not keep up with audio; please try again");
        }
      }
    }).catch((error) => {
      if (generation === lifecycleGeneration && !isStopping) {
        fail(error.message || "Could not send audio to dictation service");
      }
    }).finally(() => {
      if (generation === lifecycleGeneration) pendingAudio = Math.max(0, pendingAudio - 1);
    });
  };
  sourceNode.connect(processorNode);
  processorNode.connect(muteNode);
  muteNode.connect(audioContext.destination);
}

async function start(config = {}) {
  if (audioContext || isStartingAudio || isStopping) return;
  const generation = ++lifecycleGeneration;
  let sessionStarted = false;
  isStartingAudio = true;
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
    if (result?.status !== "accepted") {
      throw new Error(result?.message || "Dictation service is not ready");
    }
    sessionStarted = true;
    if (generation !== lifecycleGeneration || isStopping) return;
    await startAudio(config, generation);
    if (generation !== lifecycleGeneration || isStopping) return;
    window.openflow.reportStatus("recording", "Listening...", true);
  } catch (error) {
    if (generation !== lifecycleGeneration) return;
    if (sessionStarted) {
      // A microphone permission/device failure happens after main has created a
      // session. Release it without delaying the user-visible error.
      dictationApi().cancel().catch(() => {});
    }
    fail(error.message || "Could not start dictation");
  } finally {
    if (generation === lifecycleGeneration) isStartingAudio = false;
  }
}

async function handleStopTimeout(generation) {
  if (!isStopping || generation !== lifecycleGeneration) return;
  try {
    await dictationApi().reset();
  } catch {}
  if (!isStopping || generation !== lifecycleGeneration) return;
  fail("Transcription timed out; speech worker was restarted");
}

async function stop() {
  if (isStopping) return;
  isStopping = true;
  const generation = ++lifecycleGeneration;
  stopAudio();
  try {
    const result = await dictationApi().stop();
    if (result?.status !== "accepted") {
      throw new Error(result?.message || "No active dictation session");
    }
  } catch (error) {
    fail(error.message || "Could not stop dictation");
    return;
  }
  clearTimeout(stopTimer);
  stopTimer = setTimeout(() => handleStopTimeout(generation), STOP_TIMEOUT_MS);
}

window.openflow.onStartDictation?.(start);
window.openflow.onStopDictation?.(stop);
