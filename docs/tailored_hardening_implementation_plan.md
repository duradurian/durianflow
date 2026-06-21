# Worker Migration Implementation Record

## Delivered scope

| Area | Implementation |
| --- | --- |
| Local transport | Electron main supervises a Python sidecar over framed stdio. |
| Worker protocol | Version 1, four-byte big-endian length prefix, bounded JSON records, session ID/generation/sequence validation. |
| Audio | Recorder emits PCM16 mono 16 kHz through fixed preload APIs; it has no direct network transport. |
| Backpressure | Renderer pending-send cap, Electron bounded stdin queue, Node `drain` handling, worker audio queue cap, and credit events. |
| Lifecycle | `worker_ready`, asynchronous `model_state`, `start`, `audio`, `stop`, `cancel`, and `shutdown`. |
| Result safety | Main routes only active-generation events; cancel suppresses stale partial/final results. |
| Worker safety | `shell: false`, minimal environment, protocol-only stdout, bounded stderr capture, readiness timeout, and structured failures. |
| Compatibility | `TranscriptionSession`, VAD, merging, and model resolution remain in place. |

## Files added

```text
backend/app/worker.py
backend/app/worker_protocol.py
backend/scripts/run_worker.py
backend/tests/test_worker.py
backend/tests/test_worker_protocol.py
desktop/src/worker_supervisor.js
desktop/src/local_worker_transport.js
desktop/src/dictation_transport.js
```

## Files updated

```text
desktop/src/main.js
desktop/src/preload.js
desktop/src/recorder.js
desktop/src/recorder.html
desktop/package.json
```

## Verification completed

* Backend test suite: `python -m pytest -q` — 52 passing tests.
* Python compilation: `python -m compileall -q app scripts`.
* Desktop syntax checks: `npm run check`.
* Node-to-Python worker readiness and orderly shutdown handshake.
* Recorder source checked to ensure it contains no direct network transport, backend URL construction, or backend-token handling.

## Deferred release work

Production packaging, dependency pinning, signed installers, model checksum manifests, a GPU SKU, remote transport, and OS-level worker containment require explicit product/distribution decisions. They are documented in [hardening_plan.md](hardening_plan.md).
