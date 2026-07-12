# Compute backends

Durianflow separates the speech engine from its accelerator. MLX Whisper models and faster-whisper/CTranslate2 models are different formats and are managed independently.

| Selection | Engine | Device | Default precision | Availability |
| --- | --- | --- | --- | --- |
| `auto` | Selected at runtime | MLX → CUDA → CPU | Backend default | Recommended |
| `mlx` | `mlx-whisper` | Apple Metal | float16 | Native Apple Silicon, macOS 14+ |
| `cuda` | `faster-whisper` | NVIDIA CUDA | float16 | Compatible NVIDIA GPU and CUDA runtime |
| `cpu` | `faster-whisper` | CPU | int8 | Any platform with CTranslate2 support |

## Detection

At worker startup Durianflow probes model-free runtime capabilities:

1. MLX requires Darwin arm64, importable `mlx-whisper`, and `mlx.core.metal.is_available()`. This native probe runs in a short child process so a Metal initialization abort is reported as unavailable instead of terminating the worker.
2. CUDA requires `faster-whisper` and a positive `ctranslate2.get_cuda_device_count()` result.
3. CPU requires `faster-whisper`.

Automatic mode attempts each available engine in order. Python exceptions fall through inside the worker. If native MLX/CUDA code aborts the worker during model startup, the Electron supervisor remembers that backend for the selected model, relaunches with it disabled, and continues down the same priority list. Changing the configured backend clears this recovery state. Desktop explicit selections are strict; a directly launched explicit CUDA worker can opt into CPU compatibility fallback with `FALLBACK_TO_CPU_ON_CUDA_ERROR=true`.

The worker emits additive `requestedBackend`, `backend`, `device`, `computeType`, `availableBackends`, and `capabilities` fields in model-state events. Protocol version 1 remains compatible because existing consumers ignore unknown fields.

## Model formats

CTranslate2 model validation requires `model.bin`, `config.json`, `tokenizer.json`, and a vocabulary file. The pinned MLX Whisper loader accepts `config.json` plus either `weights.safetensors` or `weights.npz`.

Verified MLX aliases:

| Alias | MLX repository |
| --- | --- |
| `tiny` | `mlx-community/whisper-tiny-mlx` |
| `base` | `mlx-community/whisper-base-mlx` |
| `small` | `mlx-community/whisper-small-mlx` |
| `medium` | `mlx-community/whisper-medium-mlx` |
| `large-v3` | `mlx-community/whisper-large-v3-mlx` |
| `large-v3-turbo` | `mlx-community/whisper-large-v3-turbo` |
| `distil-large-v3` | `mlx-community/distil-whisper-large-v3` |

Managed MLX downloads use direct-child names prefixed by `mlx--`. This preserves the repository’s symlink/junction deletion protections while preventing format collisions.

## Offline operation

Install the required engine format first, then set `ALLOW_MODEL_DOWNLOAD=false`. Automatic fallback can only use an engine whose compatible model is installed; an MLX checkpoint cannot be used by the CPU/CUDA adapter.
