# Backend API

## `GET /health`

Returns backend and model status.

```json
{
  "status": "ok",
  "app": "whisper-live-backend",
  "model_loaded": true,
  "model_name": "large-v3-turbo",
  "device": "cuda",
  "compute_type": "float16"
}
```

## `GET /v1/models`

Returns the configured default and known faster-whisper model names.

```json
{
  "default": "large-v3-turbo",
  "available": ["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo", "distil-large-v3"]
}
```

## `WS /v1/transcribe`

The client sends a `start` JSON message, then binary PCM frames. The server sends status, partial, final, and error JSON events. See `../protocol.md` for the full schema.

## Error Codes

- `INVALID_JSON`: control frame could not be parsed.
- `INVALID_MESSAGE`: JSON shape or message type is unsupported.
- `INVALID_AUDIO_FORMAT`: sample rate, channels, or format is not supported.
- `INVALID_AUDIO_FRAME`: binary payload is not valid PCM16.
- `MISSING_START`: audio arrived before a valid `start`.
- `INFERENCE_FAILURE`: transcription failed.
- `UNAUTHORIZED`: token authentication failed when enabled.

## Optional API Token

Set `REQUIRE_API_TOKEN=true` and `API_TOKEN=...`. Clients can pass `?token=...` on the WebSocket URL or `x-api-token` where supported.
