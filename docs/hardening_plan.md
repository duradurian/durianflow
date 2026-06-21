# Hardening Status

## Implemented

The default desktop dictation path is now:

```text
sandboxed recorder -> narrow preload IPC -> Electron main -> framed stdio -> Python worker -> transcription core
```

Implemented controls:

* The recorder does not open a network transport, select a backend URL, or receive a backend token.
* Electron main validates the recorder sender, audio payload type, session state, and transcription settings.
* The Python worker uses a versioned, bounded four-byte length-prefixed JSON protocol and stdout is protocol-only.
* Audio submissions, stdout records, stderr retention, and Electron write queues are bounded.
* Worker readiness and model readiness are separate states; startup uses a handshake rather than a fixed delay.
* The worker runs without a shell and is supervised by Electron main.
* Stop finalizes accepted audio. Cancel invalidates the active generation, and Electron main suppresses stale results.
* The local transcription worker is the only supported transcription transport.

## Remaining production work

These are release gates, not omissions from the local transport migration:

1. Bundle/provision Python without a source checkout and resolve worker paths outside `app.asar`.
2. Pin dependencies, sign installers, and produce a clean-machine CPU smoke test.
3. Define a model manifest with approved revisions, checksums, storage, and update policy.
4. Define and test a separate GPU distribution matrix.
5. Decide whether a remote transcription product mode is supported; if so, add a main-owned remote transport and credential storage.
6. Define Windows OS-level containment/process-tree guarantees beyond stdio isolation.

See [architecture.md](architecture.md) for the current design and [local-setup.md](local-setup.md) for development setup.
