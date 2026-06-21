# Windows Release Checklist

This checklist is a release blocker. It exists because a source checkout is
not itself a trusted Windows deliverable.

## Before build

- [ ] Review all changes since the prior release, including security fixes and
  dependency updates.
- [ ] Generate and review `backend/requirements/cpu.lock` and
  `backend/requirements/gpu-windows.lock` from the `.in` inputs with
  `pip-compile --generate-hashes`; commit both files.
- [ ] Run the required Windows CI checks: desktop syntax check, backend tests,
  `npm audit`, `pip check`, and `pip-audit`.
- [ ] Review `backend/app/model_manifest.py` changes and verify that official
  model revisions, expected files, and SHA-256 values are release-controlled
  rather than installer-generated.
- [ ] Confirm that custom-model support is still configuration-file-only and
  disabled by default.

## Build and sign

- [ ] Build from a clean, pinned revision with the approved Windows build
  image. Do not build a release from a developer's modified working tree.
- [ ] Bundle the fixed Python sidecar, its native dependencies, and official
  model metadata from application-controlled paths. A packaged build must not
  use `PATH`, `DURIANFLOW_PYTHON`, or a system Python fallback.
- [ ] Produce an installer and executable with ASAR enabled except for the
  explicitly required sidecar/native files.
- [ ] Authenticode-sign the installer and executable using the protected
  release certificate; timestamp each signature.
- [ ] Verify signatures on a separate Windows host with
  `signtool verify /pa /all <artifact>`.
- [ ] Generate SHA-256 checksums, an SBOM covering npm and Python components,
  and build provenance containing the source revision, CI run ID, lockfile
  digests, and build-image identity.

## Inspect and test the artifact

- [ ] Inspect the package contents: no source `.env`, credentials, test data,
  development overrides, or unexpected executable may be present.
- [ ] Confirm the signed sidecar and official model metadata are in their
  expected packaged locations and the installer has no user-writable executable
  search path.
- [ ] On a clean offline Windows VM, install the artifact and verify startup,
  worker launch, a short dictation, cancellation, and safe copy fallback when
  automatic paste target verification fails.
- [ ] Capture a network trace during that smoke test and confirm there is no
  listener and no unexpected outbound connection. A release that needs a model
  download must document and approve that connection separately.
- [ ] Exercise malformed IPC, stale-final-result, hung-worker timeout, model
  integrity failure, traversal/reparse-point rejection, and rapid
  start/stop/cancel tests.

## Publish and retain evidence

- [ ] Publish only the signed installer, checksums, SBOM, provenance, and
  release notes. Do not publish the signing certificate or secrets.
- [ ] Record CI links, signature verification output, offline-smoke evidence,
  scans, and approver in the release record.
- [ ] Update `SECURITY.md` and user-facing risk notes if the release changes a
  trust boundary or security default.
