# Python dependency locking

The `.in` files in this directory describe direct dependencies. They are not
reproducible or release-safe on their own. A Windows distribution must be built
only from committed, fully resolved lockfiles named `cpu.lock` and
`gpu-windows.lock` in this directory.

Generate locks in a clean Python 3.11 virtual environment with the release
tooling version approved by the release owner. `pip-compile` must be invoked
with `--generate-hashes`; review the resulting full transitive diff before
committing it.

```powershell
cd backend
python -m pip install pip-tools
pip-compile --generate-hashes --output-file requirements/cpu.lock requirements/cpu.in
pip-compile --generate-hashes --output-file requirements/gpu-windows.lock requirements/gpu-windows.in
```

Install a release environment with hash enforcement:

```powershell
python -m pip install --require-hashes -r requirements/cpu.lock
```

The source checkout keeps `requirements.txt` and
`requirements-gpu-windows.txt` as developer-convenience manifests while the
project is being migrated. They are intentionally not acceptable release
inputs. The release workflow refuses to publish until the checked-in lockfiles
exist and contain hashes.

CPU and GPU locks are separate because native CUDA packages are platform- and
driver-sensitive. A lock update requires: dependency review, `pip-audit`, unit
tests on Windows, and a fresh packaged-artifact smoke test. Never hand-edit a
generated lockfile or copy a lock from a different Python/platform target.
