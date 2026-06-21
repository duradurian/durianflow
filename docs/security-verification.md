# OWASP ASVS 5.0.0 Security Verification Record

Audit date: 2026-06-20  
Commit reviewed: `3d97c27018856abeedc2321ed12e6ef313da1fd1`  
Framework: [OWASP Application Security Verification Standard (ASVS) 5.0.0](https://owasp.org/www-project-application-security-verification-standard/) (the version specified for this review; ASVS identifiers can change between releases).  
Reviewers: `Codex`, `electron_ipc`, `worker_model`, and `privacy_build`  

This is an evidence record for the repository at the commit above, not a release approval. Every row inherits the audit date, commit, and named reviewer in the `Reviewer` column. `Not filed` means a follow-up issue is required but was not created as part of this read-only review.

## Verification evidence

| Command | Result |
|---|---|
| `desktop: npm run check` | Pass |
| `backend: python -m pytest -q` | Pass - 30 passed in 0.21s |
| `desktop: npm audit --omit=dev --audit-level=low` | Pass - 0 vulnerabilities |
| `backend: python -m pip_audit` | Fail - `pip_audit` is not installed |

## Record format

Each row supplies the required Status, Reviewer, Date (inherited: 2026-06-20), Commit (inherited: `3d97c27018856abeedc2321ed12e6ef313da1fd1`), Files reviewed, Evidence, Remaining risk, and Follow-up issue. Status is strictly `Pass`, `Fail`, or `N/A`.

### Architecture and trust boundaries

| ID | Status | Reviewer | Files reviewed | Evidence | Remaining risk | Follow-up issue |
|---|---|---|---|---|---|---|
| ARCH-01 | Pass | privacy_build | `docs/architecture.md`, `desktop/src/main.js`, `backend/app/worker_protocol.py` | Diagram and implementation show Electron → framed stdio worker → local model. | Low | — |
| ARCH-02 | Pass | privacy_build | `docs/local-setup.md`, `docs/repository-flow.md`, source tree | No FastAPI/WebSocket/listener implementation found. No launch port scan captured. | Low | — |
| ARCH-03 | Fail | privacy_build | `docs/architecture.md` | Diagram omits explicit worker-supervisor and model-store trust boundaries. | Medium | Not filed |
| ARCH-04 | Pass | privacy_build | `desktop/src/main.js`, `backend/app/worker_protocol.py`, `backend/tests/` | Main validates sender/audio; worker validates records. | Low | — |
| ARCH-05 | Fail | electron_ipc | `desktop/src/main.js`, `desktop/src/preload.js` | `completeDictation` allows any trusted renderer to trigger clipboard/paste without session or payload validation. | High | Not filed |

### Electron windows, preload, and IPC

| ID | Status | Reviewer | Files reviewed | Evidence | Remaining risk | Follow-up issue |
|---|---|---|---|---|---|---|
| ELEC-01 | Pass | electron_ipc | `desktop/src/window_security.js` | `contextIsolation: true` factory is used by all windows. | Low | — |
| ELEC-02 | Pass | electron_ipc | `desktop/src/window_security.js` | `nodeIntegration: false` factory is used by all windows. | Low | — |
| ELEC-03 | Pass | electron_ipc | `desktop/src/window_security.js` | `sandbox: true` factory is used by all windows. | Low | — |
| ELEC-04 | Pass | electron_ipc | `desktop/src/` | No `webSecurity: false` found. | Low | — |
| ELEC-05 | Pass | electron_ipc | `desktop/src/` | No `allowRunningInsecureContent: true` found. | Low | — |
| ELEC-06 | Pass | electron_ipc | `desktop/package.json`, `desktop/src/` | No Electron remote module/package use found. | Low | — |
| ELEC-07 | Fail | electron_ipc | `desktop/src/main.js` | Production windows do not explicitly disable DevTools or gate them behind a developer flag. | Medium | Not filed |
| ELEC-08 | Pass | electron_ipc | `desktop/src/main.js`, `desktop/src/window_security.js` | All windows use `loadFile`; navigation and `window.open` are denied. | Low | — |
| ELEC-09 | Pass | electron_ipc | `desktop/src/*.html` | All local HTML pages have CSP meta tags. | Low | — |
| ELEC-10 | Pass | electron_ipc | `desktop/src/window_security.js` | `setWindowOpenHandler` and `will-navigate` deny navigation. | Low | — |
| PRELOAD-01 | Pass | electron_ipc | `desktop/src/preload.js` | Fixed API only; no generic `send`/`invoke` bridge. | Low | — |
| PRELOAD-02 | Pass | electron_ipc | `desktop/src/preload.js` | No Node, filesystem, child-process, shell, or environment API exposed. | Low | — |
| PRELOAD-03 | Fail | electron_ipc | `desktop/src/preload.js` | Only ArrayBuffer/callback are checked; other arguments have no size/shape validation. | High | Not filed |
| PRELOAD-04 | Pass | electron_ipc | `desktop/src/preload.js` | Renderer cannot pass a raw IPC channel name. | Low | — |
| PRELOAD-05 | Pass | electron_ipc | `desktop/src/preload.js` | Subscriptions use fixed event names. | Low | — |
| PRELOAD-06 | Fail | electron_ipc | `desktop/src/main.js`, `desktop/src/preload.js` | `config:get` exposes full config and `configPath` to all trusted renderers. | Medium | Not filed |
| IPC-01 | Fail | electron_ipc | `desktop/src/main.js` | Multiple handlers accept unvalidated payloads; completion can paste arbitrary text. | High | Not filed |
| IPC-02 | Fail | electron_ipc | `desktop/src/main.js` | No explicit unknown-channel rejection/logging test. | Medium | Not filed |
| IPC-03 | Fail | electron_ipc | `desktop/src/main.js` | `sanitizeConfig` spreads/persists unknown fields. | Medium | Not filed |
| IPC-04 | Fail | electron_ipc | `desktop/src/main.js`, `desktop/src/local_worker_transport.js` | 64 KiB downstream cap exists, but main first converts arbitrary ArrayBuffer. | Medium | Not filed |
| IPC-05 | Fail | electron_ipc | `desktop/src/main.js`, `desktop/src/local_worker_transport.js` | Session state is not strictly enforced through stop/cancel; no state-machine tests. | High | Not filed |
| IPC-06 | Pass | electron_ipc | `desktop/src/main.js`, `desktop/src/local_worker_transport.js` | Session UUID is main-generated and generation tracking drops stale events. | Low | — |
| IPC-07 | Pass | electron_ipc | `desktop/src/main.js`, `desktop/src/local_worker_transport.js` | Audio without a live session is rejected. | Low | — |
| IPC-08 | Fail | electron_ipc | `desktop/src/main.js` | Invalid IPC is silently rejected; no security-event logging evidence. | Medium | Not filed |

### Audio capture and privacy

| ID | Status | Reviewer | Files reviewed | Evidence | Remaining risk | Follow-up issue |
|---|---|---|---|---|---|---|
| AUDIO-01 | Pass | privacy_build | `desktop/src/main.js` | Main instructs capture only after hotkey/tray dictation flow. | Low | — |
| AUDIO-02 | Fail | privacy_build | `desktop/src/recorder.js`, `desktop/src/main.js` | Normal stop cleans tracks; quit/window-close/worker-crash matrix and tests are absent. | Medium | Not filed |
| AUDIO-03 | Pass | privacy_build | `desktop/src/recorder.js`, `desktop/src/main.js` | Recorder/main enforce mono PCM16 at 16 kHz. | Low | — |
| AUDIO-04 | Pass | privacy_build | `desktop/src/recorder.js`, `desktop/src/worker_supervisor.js`, `backend/app/worker.py` | Renderer pending cap and main/worker queue/frame caps exist. | Low | — |
| AUDIO-05 | Pass | privacy_build | `docs/architecture.md`, runtime source tree | No raw-audio persistence path found; docs state memory-only state. | Low | — |
| AUDIO-06 | Pass | privacy_build | `desktop/src/main.js`, `desktop/src/status.html` | Recording status indicator is rendered. | Low | — |
| AUDIO-07 | Pass | privacy_build | `backend/tests/test_worker.py`, `desktop/src/local_worker_transport.js` | Cancellation/stale-result suppression is tested in backend. | Low | — |

### Worker supervisor and Python command validation

| ID | Status | Reviewer | Files reviewed | Evidence | Remaining risk | Follow-up issue |
|---|---|---|---|---|---|---|
| WORKER-01 | Pass | worker_model | `desktop/src/worker_supervisor.js` | `spawn(command,args,{shell:false})`. | Low | — |
| WORKER-02 | Fail | worker_model | `desktop/src/main.js`, `desktop/src/worker_supervisor.js` | `DURIANFLOW_PYTHON` can choose executable; trust boundary not fixed. | Medium | Not filed |
| WORKER-03 | Pass | worker_model | `desktop/src/worker_supervisor.js`, `backend/app/worker_protocol.py` | 160 KiB/derived bounded frame constants. | Low | — |
| WORKER-04 | Pass | worker_model | `desktop/src/worker_supervisor.js`, `backend/app/worker_protocol.py`, tests | Malformed JSON/non-object/length frames fail closed. | Low | — |
| WORKER-05 | Pass | worker_model | `desktop/src/worker_supervisor.js`, `backend/app/worker_protocol.py` | Oversize record is rejected and supervisor stops worker. | Low | — |
| WORKER-06 | Fail | worker_model | `desktop/src/worker_supervisor.js` | Startup/shutdown timeouts exist; no response timeout or kill-on-hung inference. | Medium | Not filed |
| WORKER-07 | N/A | worker_model | `desktop/src/worker_supervisor.js` | No automatic restart loop is implemented. | None | — |
| WORKER-08 | Pass | worker_model | `desktop/src/local_worker_transport.js`, `backend/app/worker.py` | Session/generation mismatches are discarded. | Low | — |
| WORKER-09 | Pass | worker_model | `desktop/src/worker_supervisor.js`, `backend/app/worker.py` | Protocol-only stdout and bounded stderr; no raw-audio/transcript log call found. | Low | — |
| PY-01 | Pass | worker_model | `backend/app/worker_protocol.py` | Explicit six-command allowlist. | Low | — |
| PY-02 | Pass | worker_model | `backend/app/worker_protocol.py` | Unknown command raises `ProtocolError`. | Low | — |
| PY-03 | Fail | worker_model | `backend/app/worker_protocol.py`, `backend/app/schemas.py` | Session IDs lack UUID/length constraint; extra fields are ignored. | Medium | Not filed |
| PY-04 | Fail | worker_model | `desktop/src/main.js`, `backend/app/worker_protocol.py` | Main creates UUID, but worker accepts any nonempty start-session ID. | Medium | Not filed |
| PY-05 | Pass | worker_model | `backend/app/worker.py`, supervisor | Audio credits and queue byte caps bound streaming. | Low | — |
| PY-06 | Fail | worker_model | `backend/app/worker.py` | Exceptions emit `str(exc)`, potentially exposing internals. | Medium | Not filed |
| PY-07 | Pass | worker_model | `backend/app/worker.py`, `backend/app/worker_protocol.py` | No user command supports arbitrary file/shell/import operations. | Low | — |

### Model store and installation

| ID | Status | Reviewer | Files reviewed | Evidence | Remaining risk | Follow-up issue |
|---|---|---|---|---|---|---|
| MODEL-01 | Fail | worker_model | `backend/app/model_store.py`, `backend/app/config.py` | Model names are arbitrary; no trusted metadata/allowlist. | High | Not filed |
| MODEL-02 | Fail | worker_model | `backend/app/model_store.py` | `MODEL_PATH` can be absolute and outside model directory. | High | Not filed |
| MODEL-03 | Fail | worker_model | `backend/app/model_store.py`, tests | No handling/tests for traversal, symlinks, UNC, or attacker paths. | High | Not filed |
| MODEL-04 | Fail | worker_model | `backend/scripts/install_model.py` | Installer accepts arbitrary model/repository identifier. | High | Not filed |
| MODEL-05 | Fail | worker_model | `backend/scripts/install_model.py` | No checksum, signature, or pinned artifact validation. | High | Not filed |
| MODEL-06 | Fail | worker_model | `backend/scripts/install_model.py` | Arbitrary absolute `--models-dir` plus force deletion has no boundary guard. | High | Not filed |
| MODEL-07 | Pass | worker_model | `backend/scripts/install_model.py` | Downloaded models are copied/read as data, never executed. | Low | — |
| MODEL-08 | Fail | worker_model | `backend/scripts/install_model.py` | Failure path lacks guaranteed temporary-download cleanup. | Medium | Not filed |

### Refinement, clipboard, logging, and configuration

| ID | Status | Reviewer | Files reviewed | Evidence | Remaining risk | Follow-up issue |
|---|---|---|---|---|---|---|
| REFINE-01 | Pass | privacy_build | `desktop/src/main.js`, `advanced_settings.html` | `llmEnabled: false` default and opt-in UI. | Low | — |
| REFINE-02 | Pass | privacy_build | `desktop/src/main.js`, `desktop/src/text_processor.js` | Localhost defaults; remote URLs gated by explicit setting. | Low | — |
| REFINE-03 | Pass | privacy_build | `desktop/src/advanced_settings.html` | Remote-use warning text exists. | Low | — |
| REFINE-04 | Pass | privacy_build | `desktop/src/text_processor.js` | Prompt uses dictation/editing instructions, not private app metadata. | Low | — |
| REFINE-05 | Pass | privacy_build | `desktop/src/text_processor.js`, `desktop/src/main.js` | Failure returns original transcript. | Low | — |
| REFINE-06 | Pass | privacy_build | `desktop/src/main.js` | Refined text reaches paste only; no execution path. | Low | — |
| CLIP-01 | Fail | electron_ipc | `desktop/src/preload.js`, `desktop/src/main.js` | Any trusted renderer can invoke `completeDictation` and paste without dictation completion. | High | Not filed |
| CLIP-02 | Fail | electron_ipc | `desktop/src/main.js` | No target-window capture/recheck before synthetic Ctrl+V. | High | Not filed |
| CLIP-03 | Pass | electron_ipc | `desktop/src/main.js`, settings UI | `autoPaste: false` copies only. | Low | — |
| CLIP-04 | Fail | electron_ipc | `desktop/src/main.js` | Cancelled/failed/stale states are not enforced at `completeDictation`. | High | Not filed |
| CLIP-05 | Pass | electron_ipc | `desktop/src/main.js` | Clipboard read is for restoration around write/paste. | Low | — |
| CLIP-06 | Pass | electron_ipc | `desktop/src/main.js`, backend logging | No clipboard logging call found. | Low | — |
| CLIP-07 | Fail | electron_ipc | `desktop/src/preload.js`, `desktop/src/main.js` | Renderer IPC can reach fixed paste routine through `completeDictation`. | High | Not filed |
| LOG-01 | Pass | privacy_build | `backend/app/worker.py` | No raw-audio logging found. | Low | — |
| LOG-02 | Pass | privacy_build | `backend/app/worker.py`, transcriber | No full-transcript logging found. | Low | — |
| LOG-03 | Pass | privacy_build | `desktop/src/main.js`, backend logging | No clipboard contents logged. | Low | — |
| LOG-04 | Fail | privacy_build | `backend/app/transcriber.py`, `backend/app/cuda_runtime.py` | Full local paths are logged; no redaction test. | Medium | Not filed |
| LOG-05 | Fail | privacy_build | `desktop/src/main.js`, `backend/app/worker.py` | Worker failures log, but invalid IPC is silent; no central security-event log. | Medium | Not filed |
| LOG-06 | Fail | privacy_build | `backend/app/logging_config.py` | `basicConfig` only; no rotation/size limit. | Medium | Not filed |
| LOG-07 | N/A | privacy_build | source tree | No crash reporter integration. | None | — |
| LOG-08 | Pass | privacy_build | `backend/app/worker.py` | Default level is INFO; no production debug switch found. | Low | — |
| CONFIG-01 | Fail | privacy_build | `desktop/src/main.js` | User-data config write has no ACL/permission verification. | Medium | Not filed |
| CONFIG-02 | Fail | privacy_build | `desktop/src/main.js`, `backend/app/config.py` | Unknown values are spread/ignored instead of rejected. | Medium | Not filed |
| CONFIG-03 | Pass | privacy_build | `desktop/src/main.js` | Retired backend network config removed; remote LLM explicit. | Low | — |
| CONFIG-04 | N/A | privacy_build | build configuration | No production developer-flag system exists. | Medium | — |
| CONFIG-05 | Fail | privacy_build | `backend/app/config.py`, `desktop/src/main.js` | Remote refinement/retention default safe, but model download defaults enabled. | Medium | Not filed |

### Dependencies, build/release, negative testing, and docs

| ID | Status | Reviewer | Files reviewed | Evidence | Remaining risk | Follow-up issue |
|---|---|---|---|---|---|---|
| DEP-01 | Pass | privacy_build | `desktop/package-lock.json` | `npm audit` reports 0 vulnerabilities. | Low | — |
| DEP-02 | Fail | privacy_build | `backend/requirements.txt` | `pip_audit` absent; no Python dependency scan/CI. | High | Not filed |
| DEP-03 | N/A | privacy_build | `desktop/package.json` | Electron is `^42.0.1`; no support policy/CI proof. | Medium | — |
| DEP-04 | Fail | privacy_build | lockfiles | npm lockfile committed; no Python lockfile. | Medium | Not filed |
| DEP-05 | Fail | privacy_build | `backend/requirements.txt`, installer | Unpinned Python deps and unverified model downloads. | High | Not filed |
| DEP-06 | Fail | privacy_build | repository workflows | No artifact provenance/release checklist. | High | Not filed |
| DEP-07 | N/A | privacy_build | release configuration | No Windows installer artifact exists. | Medium | — |
| BUILD-01 | Fail | privacy_build | `desktop/src/main.js` | No packaged-build config; DevTools not explicitly off. | Medium | Not filed |
| BUILD-02 | Pass | privacy_build | `desktop/src/main.js` | No unsafe Chromium switch source usage found. | Low | — |
| BUILD-03 | N/A | privacy_build | artifacts | No packaged artifact to inspect. | Medium | — |
| BUILD-04 | N/A | privacy_build | artifacts | No ASAR/package artifact to scan. | Medium | — |
| BUILD-05 | N/A | privacy_build | source tree | No auto-updater. | None | — |
| BUILD-06 | N/A | privacy_build | source tree | No update channels. | None | — |
| TEST-01 | Fail | Codex | desktop test suite | No malformed-IPC desktop negative test. | High | Not filed |
| TEST-02 | Fail | Codex | desktop/backend tests | Limits exist but no renderer flood stress test. | Medium | Not filed |
| TEST-03 | Pass | worker_model | `backend/tests/test_worker_protocol.py` | 12 targeted worker/protocol/model tests passed; malformed framing covered. | Low | — |
| TEST-04 | Fail | Codex | supervisor tests | No worker-hang/model-load timeout fault test. | Medium | Not filed |
| TEST-05 | Fail | Codex | transport/backend tests | Code suppresses stale events; no explicit old-final-result test. | Medium | Not filed |
| TEST-06 | Fail | Codex | UI tests | No focus-change-before-paste UI test. | High | Not filed |
| TEST-07 | Fail | Codex | model-store tests | No traversal/symlink/UNC path test. | High | Not filed |
| TEST-08 | Fail | Codex | runtime evidence | No offline launch network capture. | Medium | Not filed |
| TEST-09 | Fail | Codex | tests | No long-dictation memory test. | Medium | Not filed |
| TEST-10 | Fail | Codex | tests | No rapid start/stop/cancel race test. | Medium | Not filed |
| DOC-01 | Pass | privacy_build | `README.md`, `docs/architecture.md` | Local/memory-only processing is documented. | Low | — |
| DOC-02 | Pass | privacy_build | `desktop/src/advanced_settings.html` | Local/remote refinement options are explained. | Low | — |
| DOC-03 | Pass | privacy_build | `docs/troubleshooting.md` | No unsafe-flag recommendation found. | Low | — |
| DOC-04 | Fail | privacy_build | repository root | No `SECURITY.md` or reporting process. | Medium | Not filed |
| DOC-05 | Fail | privacy_build | `README.md` | Does not explain malware, unlocked-PC, or clipboard risks. | Medium | Not filed |

## Release-blocking remediation order

1. Remove renderer-driven finalization/paste. Main must own final transcripts, enforce active session/generation/terminal state, and capture/revalidate the intended target before paste.
2. Lock down model installation: allowlist model IDs, constrain canonical paths to a controlled model root, reject symlink/UNC/traversal inputs, and use a pinned integrity manifest.
3. Add strict IPC/config schemas, receiver-side size limits before allocation, security-event logging with redaction/rotation, and desktop negative/integration tests.
4. Establish the release baseline: pinned Python dependencies and scan, signed/provenanced package build, artifact inspection, `SECURITY.md`, and user-facing threat/clipboard limitations.

## Remediation tracking (2026-06-21)

This section records implementation work after the review above. It is not a
new ASVS verification: the original status rows remain the evidence snapshot
for commit `3d97c27018856abeedc2321ed12e6ef313da1fd1` and must be re-tested on
the release candidate.

| Work item | Implemented control | Verification still required |
|---|---|---|
| Vulnerability reporting | Root `SECURITY.md` defines private GitHub reporting, scope, and response targets. | Enable GitHub private vulnerability reporting for the repository and test its routing. |
| Dependency baseline | `backend/requirements/*.in` defines CPU/GPU/dev sources; the release gate rejects a release without committed hash-bearing CPU and Windows GPU locks. | Generate, review, commit, and install from the actual lockfiles; remediate any audit findings. |
| Continuous checks | `.github/workflows/security.yml` runs Windows desktop syntax, npm audit, backend tests, pip check, and pip-audit. | Confirm workflow execution on the repository and tune any justified audit exceptions. |
| Release provenance | `docs/release-checklist.md` requires signing, checksums, SBOM, provenance, artifact inspection, and clean offline Windows smoke evidence. | Add protected signing secrets/build infrastructure and attach the evidence to an actual release. |
| User-facing threats | README and desktop documentation describe clipboard, auto-paste, malware/unlocked-session, and custom-model limitations. | Recheck UI copy against the final settings implementation. |
