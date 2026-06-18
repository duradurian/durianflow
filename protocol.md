# Whisper Live WebSocket Protocol

The backend exposes `WS /v1/transcribe`. JSON frames are used for control and transcript events. Binary frames are raw little-endian signed 16-bit PCM, mono, 16 kHz.

## Client Start

```json
{
  "type": "start",
  "session_id": "uuid-string",
  "sample_rate": 16000,
  "channels": 1,
  "format": "pcm_s16le",
  "language": "en",
  "mode": "fast"
}
```

The server responds:

```json
{
  "type": "ready",
  "session_id": "uuid-string",
  "model": "large-v3-turbo",
  "sample_rate": 16000
}
```

## Audio Frames

After `ready`, the client sends binary WebSocket frames containing raw `pcm_s16le` audio. Frames should be small, roughly 20-100 ms. The MVP accepts audio before the `ready` frame is observed by the client as long as a valid `start` was received first.

## Stop

```json
{ "type": "stop" }
```

The server finalizes any active speech and emits a `status: stopped` event.

## Transcript Events

Partial events are replaceable unstable text:

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

## Status Events

```json
{
  "type": "status",
  "status": "listening"
}
```

Known status values are `listening`, `speech_started`, `speech_ended`, `transcribing`, and `stopped`.

## Error Events

```json
{
  "type": "error",
  "code": "INVALID_AUDIO_FORMAT",
  "message": "Expected pcm_s16le, mono, 16000 Hz audio."
}
```

Common error codes are `INVALID_JSON`, `INVALID_MESSAGE`, `INVALID_AUDIO_FORMAT`, `INVALID_AUDIO_FRAME`, `MISSING_START`, `INFERENCE_FAILURE`, and `UNAUTHORIZED`.
