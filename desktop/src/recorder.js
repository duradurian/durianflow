const TARGET_SAMPLE_RATE = 16000;
const CHANNELS = 1;
const FORMAT = "pcm_s16le";

let mediaStream = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let muteNode = null;
let socket = null;
let isStopping = false;
let finalSegments = [];
let latestPartial = "";
let currentConfig = null;
let stopTimer = null;

function createSessionId() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function downsampleToPcm16(input, inputSampleRate) {
  if (!input.length) {
    return new ArrayBuffer(0);
  }

  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Int16Array(outputLength);

  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const start = Math.floor(outputIndex * ratio);
    const end = Math.min(Math.floor((outputIndex + 1) * ratio), input.length);
    let sum = 0;
    let count = 0;

    for (let inputIndex = start; inputIndex < end; inputIndex += 1) {
      sum += input[inputIndex];
      count += 1;
    }

    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, count)));
    output[outputIndex] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return output.buffer;
}

function sendStartMessage() {
  socket.send(JSON.stringify({
    type: "start",
    session_id: createSessionId(),
    sample_rate: TARGET_SAMPLE_RATE,
    channels: CHANNELS,
    format: FORMAT,
    language: currentConfig.language || null,
    mode: currentConfig.mode || "fast",
  }));
}

function backendSocketUrl() {
  const url = new URL(currentConfig.backendUrl);
  if (currentConfig.backendApiToken && !url.searchParams.has("token")) {
    url.searchParams.set("token", currentConfig.backendApiToken);
  }
  return url.toString();
}

function connectSocket() {
  return new Promise((resolve, reject) => {
    socket = new WebSocket(backendSocketUrl());
    socket.binaryType = "arraybuffer";

    socket.onopen = () => {
      sendStartMessage();
      resolve();
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") {
        return;
      }

      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (message.type === "final" && message.text) {
        finalSegments.push(message.text);
      } else if (message.type === "partial" && message.text) {
        latestPartial = message.text;
      } else if (message.type === "status" && message.status === "stopped") {
        complete();
      } else if (message.type === "error") {
        fail(message.message || message.code || "Backend error");
      }
    };

    socket.onerror = () => {
      reject(new Error("Could not connect to the transcription backend"));
    };

    socket.onclose = () => {
      if (isStopping) {
        complete();
      } else if (socket) {
        fail("Transcription backend disconnected");
      }
    };
  });
}

async function startAudio() {
  const audioConstraints = {
    channelCount: CHANNELS,
    echoCancellation: false,
    noiseSuppression: true,
    autoGainControl: true,
  };

  if (currentConfig.selectedInputDeviceId) {
    audioConstraints.deviceId = { exact: currentConfig.selectedInputDeviceId };
  }

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: audioConstraints,
    video: false,
  });

  audioContext = new AudioContext();
  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  processorNode = audioContext.createScriptProcessor(4096, CHANNELS, CHANNELS);
  muteNode = audioContext.createGain();
  muteNode.gain.value = 0;

  processorNode.onaudioprocess = (event) => {
    if (!socket || socket.readyState !== WebSocket.OPEN || isStopping) {
      return;
    }

    const input = event.inputBuffer.getChannelData(0);
    const pcm = downsampleToPcm16(input, audioContext.sampleRate);
    if (pcm.byteLength > 0) {
      socket.send(pcm);
    }
  };

  sourceNode.connect(processorNode);
  processorNode.connect(muteNode);
  muteNode.connect(audioContext.destination);
}

async function start(config) {
  if (socket || audioContext) {
    return;
  }

  try {
    currentConfig = config;
    isStopping = false;
    finalSegments = [];
    latestPartial = "";
    await connectSocket();
    await startAudio();
    window.openflow.reportStatus("recording", "Listening...", true);
  } catch (error) {
    fail(error.message || "Could not start dictation");
  }
}

function stopAudio() {
  if (processorNode) {
    processorNode.disconnect();
    processorNode.onaudioprocess = null;
    processorNode = null;
  }
  if (muteNode) {
    muteNode.disconnect();
    muteNode = null;
  }
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) {
      track.stop();
    }
    mediaStream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
}

function stop() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    complete();
    return;
  }

  isStopping = true;
  stopAudio();
  socket.send(JSON.stringify({ type: "stop" }));
  clearTimeout(stopTimer);
  stopTimer = setTimeout(() => complete(), 5000);
}

function transcriptText() {
  const finals = finalSegments.join(" ").trim();
  return finals || latestPartial.trim();
}

function cleanupSocket() {
  if (socket) {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
    socket = null;
  }
}

function complete() {
  clearTimeout(stopTimer);
  stopAudio();
  const text = transcriptText();
  cleanupSocket();
  isStopping = false;
  currentConfig = null;
  window.openflow.completeDictation(text);
}

function fail(message) {
  clearTimeout(stopTimer);
  stopAudio();
  cleanupSocket();
  isStopping = false;
  currentConfig = null;
  window.openflow.failDictation(message);
}

window.openflow.onStartDictation(start);
window.openflow.onStopDictation(stop);
