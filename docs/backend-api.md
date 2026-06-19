# Backend API

## `GET /health`

Returns backend and model status.

```json
{
  "status": "ok",
  "app": "openflow-backend",
  "model_loaded": true,
  "model_loading": false,
  "model_error": null,
  "model_name": "large-v3-turbo",
  "model_source": "models/large-v3-turbo",
  "expected_model_path": "models/large-v3-turbo",
  "model_retry_after_seconds": null,
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
- `MODEL_UNAVAILABLE`: backend accepted the socket but the model is not loaded.
- `INFERENCE_FAILURE`: transcription failed.
- `UNAUTHORIZED`: token authentication failed when enabled.

## Optional API Token

Set `REQUIRE_API_TOKEN=true` and `API_TOKEN=...`. HTTP clients must send `x-api-token` or `Authorization: Bearer <token>` for `/health` and `/v1/models`. WebSocket clients can use `x-api-token`, `Authorization: Bearer <token>`, or `?token=...` when custom headers are not available.

Non-loopback/server mode requires `OPENFLOW_SERVER_MODE=true`, `REQUIRE_API_TOKEN=true`, and a non-empty `API_TOKEN`. Remote browser clients must also be listed in `ALLOWED_ORIGINS`, for example `ALLOWED_ORIGINS=https://app.example.com`.

Browser WebSocket clients can include `api_token` in the initial `start` message instead of putting the token in the URL query string. Query-string tokens remain accepted for compatibility.
