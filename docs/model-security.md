# Model Trust and Custom-Model Configuration

Durianflow separates official model artifacts from user-managed custom models.
This distinction is intentional: a custom model must never acquire official
trust simply because it can be loaded from disk.

## Official models

Official model policy is repository-controlled in
`backend/app/model_manifest.py`. The manifest identifies the approved model,
immutable upstream revision, required files, and SHA-256 values. Installation
stages content under the managed `MODELS_DIR`, verifies it against this
metadata, and only then activates it. Runtime model download remains disabled
for the packaged application.

## Custom models

Custom models are disabled unless both backend configuration and a separate
configuration file opt in. The relevant backend environment settings are:

```env
CUSTOM_MODELS_DIR=C:\Durianflow\custom-models
CUSTOM_MODEL_CONFIG_PATH=C:\Durianflow\custom-models\model.json
```

`CUSTOM_MODEL_CONFIG_PATH` must resolve beneath `CUSTOM_MODELS_DIR`. It is a
JSON file with this exact public shape:

```json
{
  "version": 1,
  "enabled": true,
  "modelId": "my-model-v1"
}
```

`modelId` must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. Unknown fields,
invalid JSON, unsupported versions, disabled configuration, and paths outside
the configured custom root are rejected. The custom model is structural-only:
Durianflow checks its allowed location and expected model shape, but does not
represent it as an integrity-verified official artifact.

Treat this file and its root as sensitive local policy. A user or program able
to modify them can choose a different custom model. This configuration is not
a defense against malware, administrators, or an unlocked Windows session.

Do not expose the custom root or configuration path to renderer IPC, do not
enable it from a renderer setting, and do not configure UNC paths, reparse
points, or paths that escape the root.
