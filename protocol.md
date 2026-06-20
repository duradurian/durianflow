# Openflow Backend Protocol

Openflow exposes a local HTTP and WebSocket API for dictation clients. The Electron desktop app uses the same protocol as custom clients.

Default local endpoints:

```text
GET http://127.0.0.1:8000/health
GET http://127.0.0.1:8000/v1/models
WS  ws://127.0.0.1:8000/v1/transcribe
```

## Runtime Model State

Model loading runs in the background. The HTTP server can answer `/health` while the Whisper model is still downloading, loading, retrying, or degraded.

`GET /health` returns:

```json
{
  "status": "degraded",
  "app": "openflow-backend",
  "model_loaded": false,
  "model_loading": true,
  "model_error": null,
  "model_name": "large-v3-turbo",
  "model_source": null,
  "expected_model_path": "C:\\Users\\Darrien\\Desktop\\Openflow\\backend\\models\\large-v3-turbo",
  "model_retry_after_seconds": null,
  "device": "cuda",
  "compute_type": "float16",
  "active_device": "cuda",
  "active_compute_type": "float16"
}
```

Fields:

- `status`: `ok` when `model_loaded=true`, otherwise `degraded`.
- `model_loaded`: true only when transcription can start.
- `model_loading`: true while a background model load attempt is running.
- `model_error`: last load error, or `null` while loading or ready.
- `model_source`: resolved loaded model source when ready.
- `expected_model_path`: local path where the configured model is expected or cached.
- `model_retry_after_seconds`: cooldown before the next automatic retry after a failed load.
- `device` / `compute_type`: configured runtime target.
- `active_device` / `active_compute_type`: actual loaded target. These may be `cpu` / `int8` when CUDA fallback is enabled.

`GET /v1/models` returns:

```json
{
  "default": "large-v3-turbo",
  "available": ["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo", "distil-large-v3"]
}
```

## Authentication And Trust

Local desktop mode is loopback-first. Non-loopback binding requires:

```env
OPENFLOW_SERVER_MODE=true
REQUIRE_API_TOKEN=true
API_TOKEN=...
```

HTTP requests authenticate with either:

```text
x-api-token: <token>
Authorization: Bearer <token>
```

WebSocket clients may authenticate with:

- `x-api-token` header
- `Authorization: Bearer <token>` header
- `?token=<token>` query parameter
- `api_token` in the first `start` message

Browser clients usually cannot set custom WebSocket headers, so the Electron recorder sends `api_token` in the `start` message.

WebSocket connections are also checked by `Host` and `Origin`. Local mode allows loopback hosts and local origins such as `file://` and `null`. In server mode, remote browser origins must be listed in `ALLOWED_ORIGINS`.

## WebSocket Session Flow

Clients connect to:

```text
WS /v1/transcribe
```

All control and event frames are JSON text frames. Audio frames are binary little-endian signed 16-bit PCM.

A normal session is:

```text
connect
client -> start JSON
server -> ready
server -> status:listening
client -> binary PCM frames
server -> status / partial / final events
client -> stop JSON
server -> optional final
server -> status:stopped
server closes session loop
```

Only one `start` message is accepted per WebSocket connection.

## Start Message

```json
{
  "type": "start",
  "session_id": "uuid-string",
  "sample_rate": 16000,
  "channels": 1,
  "format": "pcm_s16le",
  "language": "en",
  "mode": "fast",
  "api_token": "optional-token-for-browser-clients"
}
```

Rules:

- `sample_rate` must be `16000`.
- `channels` must be `1`.
- `format` must be `pcm_s16le`.
- `mode` must be `fast` or `accurate`.
- `language` may be a language code or `null`.
- `session_id` is treated as an opaque string.
- `api_token` is accepted only for authentication and is not echoed.

If the model is not loaded, the server returns `MODEL_UNAVAILABLE` and keeps the socket open for another valid control message.

## Ready Event

After a valid `start`, the server sends:

```json
{
  "type": "ready",
  "session_id": "uuid-string",
  "model": "large-v3-turbo",
  "sample_rate": 16000
}
```

The `model` field is the configured model name, not necessarily a local filesystem path.

## Audio Frames

After a valid `start`, the client sends binary frames:

```text
pcm_s16le, mono, 16000 Hz
```

Recommended frame size is roughly 20-100 ms. The Electron client currently sends frames from a Web Audio processor after downsampling to 16 kHz.

Odd-length PCM byte payloads are invalid and return `INVALID_AUDIO_FRAME`.

## Stop Message

```json
{
  "type": "stop"
}
```

If speech is active, the backend finalizes it. If there is no active session, the backend still returns `status:stopped`.

## Status Events

```json
{
  "type": "status",
  "status": "listening",
  "message": "optional human-readable detail"
}
```

Known status values:

- `listening`: session is ready for audio.
- `speech_started`: VAD detected speech.
- `speech_ended`: VAD detected enough silence or the utterance hit the maximum buffer length.
- `transcribing`: backend is running final transcription for the current utterance.
- `stopped`: session has stopped.

## Transcript Events

Partial events are replaceable, unstable text:

```json
{
  "type": "partial",
  "session_id": "uuid-string",
  "segment_id": "seg_000001",
  "text": "this is unstable partial text",
  "start": 1.25,
  "end": 4.8,
  "is_final": false
}
```

Final events are permanent:

```json
{
  "type": "final",
  "session_id": "uuid-string",
  "segment_id": "seg_000001",
  "text": "This is the finalized transcript.",
  "start": 1.25,
  "end": 5.1,
  "is_final": true
}
```

Timestamps are positions in received session audio, not raw Whisper segment timestamps.

The desktop client inserts finalized segments when present. If no final segment arrives before stop/close, it falls back to the latest partial.

## Error Events

```json
{
  "type": "error",
  "code": "INVALID_AUDIO_FORMAT",
  "message": "Expected pcm_s16le, mono, 16000 Hz audio."
}
```

Known error codes:

- `INVALID_JSON`: control frame was not valid JSON.
- `INVALID_MESSAGE`: JSON shape or message type was unsupported.
- `INVALID_AUDIO_FORMAT`: `start` requested unsupported sample rate, channels, or format.
- `INVALID_AUDIO_FRAME`: binary payload was not valid PCM16.
- `MISSING_START`: audio arrived before a valid `start`.
- `MODEL_UNAVAILABLE`: model was not loaded when `start` was received.
- `INFERENCE_FAILURE`: transcription failed after a valid start.
- `UNAUTHORIZED`: token authentication failed.

Authentication failures close the socket with policy violation code `1008` after the error event when possible.

## Desktop Startup Contract

Running `npm start` from `desktop/` launches Electron. The desktop app then:

1. Loads local desktop config.
2. Registers the configured hotkey. On Windows, toggle mode falls back to a physical key-state watcher if Electron cannot claim the shortcut.
3. Starts the backend automatically when the configured health URL is local and unreachable.
4. Does not spawn another backend if `/health` is reachable but the model is still loading or degraded.
5. Shows model preparation status and waits for `model_loaded=true` before starting microphone capture.
6. Lets a second toggle press, or a hold-key release, cancel a pending model-preparation attempt.
7. Sends the backend API token in the WebSocket `start` message when configured.

If the model is missing and downloads are allowed, the backend downloads/caches it in the background. If downloads are blocked or disabled, `/health` remains reachable with `status=degraded` and a `model_error` explaining the setup issue.
