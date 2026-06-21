# Local Worker Protocol

Electron main and `backend/scripts/run_worker.py` communicate over stdin/stdout.
Each record is a four-byte big-endian length followed by a UTF-8 JSON object.
Protocol version is `1`; all record and audio sizes are bounded before decoding.

Commands sent to the worker are `hello`, `start`, `audio`, `stop`, `cancel`,
and `shutdown`. Session commands include `sessionId`, `generation`, and a
monotonic `sequence`. Audio commands carry bounded base64-encoded mono 16 kHz
`pcm_s16le` payloads in `audioBase64`.

The worker emits `worker_ready`, `model_state`, `accepted`, `ready`, `status`,
`partial`, `final`, `stopped`, `canceled`, `error`, and `shutdown_ack` records.
`accepted.creditBytes` provides the sender's audio-flow-control budget.

The local worker has no HTTP endpoint or network listener.
