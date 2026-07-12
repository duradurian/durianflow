from __future__ import annotations

import importlib
import importlib.util
import logging
import platform
import subprocess
import sys
from dataclasses import dataclass
from typing import Callable, Literal

from app.cuda_runtime import configure_cuda_dll_paths

logger = logging.getLogger(__name__)

BackendName = Literal["mlx", "cuda", "cpu"]
RequestedBackend = Literal["auto", "mlx", "cuda", "cpu"]
BACKEND_PRIORITY: tuple[BackendName, ...] = ("mlx", "cuda", "cpu")


class BackendUnavailableError(RuntimeError):
    pass


@dataclass(frozen=True)
class BackendCapability:
    name: BackendName
    available: bool
    device: str
    compute_type: str
    reason: str | None = None

    def as_dict(self) -> dict[str, str | bool | None]:
        return {
            "name": self.name,
            "available": self.available,
            "device": self.device,
            "computeType": self.compute_type,
            "reason": self.reason,
        }


def _module_available(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ModuleNotFoundError, ValueError):
        return False


def _probe_mlx_runtime(
    *,
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
    timeout_seconds: float = 10,
) -> tuple[bool, str | None]:
    """Probe MLX in a child because native Metal initialization can abort."""
    code = (
        "import mlx.core as mx\n"
        "from mlx_whisper.transcribe import ModelHolder, transcribe\n"
        "metal = getattr(mx, 'metal', None)\n"
        "if metal is None or not metal.is_available(): raise SystemExit(3)\n"
        "if not hasattr(ModelHolder, 'get_model') or not callable(transcribe): raise SystemExit(4)\n"
        "print('available')\n"
    )
    try:
        result = runner(
            [sys.executable, "-c", code],
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return False, "MLX runtime probe timed out while initializing Metal."
    except OSError as exc:
        return False, f"MLX runtime probe could not start: {exc}"

    if result.returncode == 0 and result.stdout.strip().splitlines()[-1:] == ["available"]:
        return True, None
    detail_lines = [line.strip() for line in result.stderr.splitlines() if line.strip()]
    detail = detail_lines[-1][:300] if detail_lines else "runtime exited without a diagnostic"
    return False, f"MLX runtime probe failed (exit {result.returncode}): {detail}"


def detect_backend_capabilities(
    *,
    system: str | None = None,
    machine: str | None = None,
    module_available: Callable[[str], bool] = _module_available,
    importer: Callable[[str], object] = importlib.import_module,
    mlx_probe: Callable[[], tuple[bool, str | None]] | None = None,
) -> tuple[BackendCapability, ...]:
    """Probe inference engines without loading model weights.

    The injectable arguments keep platform selection fully testable on hosts
    without Metal or CUDA hardware.
    """

    system = system or platform.system()
    machine = (machine or platform.machine()).lower()
    capabilities: list[BackendCapability] = []

    if system != "Darwin" or machine not in {"arm64", "aarch64"}:
        mlx = BackendCapability(
            "mlx",
            False,
            "metal",
            "float16",
            "MLX Metal requires native Apple Silicon macOS.",
        )
    elif not module_available("mlx_whisper") or not module_available("mlx.core"):
        mlx = BackendCapability(
            "mlx",
            False,
            "metal",
            "float16",
            "Install the Apple Silicon dependencies with `pip install -r requirements.txt`.",
        )
    else:
        probe = mlx_probe or _probe_mlx_runtime
        available, reason = probe()
        mlx = BackendCapability(
            "mlx",
            available,
            "metal",
            "float16",
            reason,
        )
    capabilities.append(mlx)

    if system == "Windows":
        # Native CTranslate2 imports may themselves depend on pip-installed
        # NVIDIA DLL directories, so register them before the first import.
        configure_cuda_dll_paths()

    faster_whisper_available = False
    faster_whisper_error: str | None = None
    if module_available("faster_whisper"):
        try:
            importer("faster_whisper")
            importer("ctranslate2")
            faster_whisper_available = True
        except Exception as exc:
            faster_whisper_error = f"faster-whisper runtime import failed: {exc}"
    else:
        faster_whisper_error = "faster-whisper is not installed."

    if not faster_whisper_available:
        cuda = BackendCapability(
            "cuda",
            False,
            "cuda",
            "float16",
            faster_whisper_error,
        )
    else:
        try:
            ctranslate2 = importer("ctranslate2")
            count = int(ctranslate2.get_cuda_device_count())
            cuda = BackendCapability(
                "cuda",
                count > 0,
                "cuda",
                "float16",
                None if count > 0 else "No compatible NVIDIA CUDA device was detected.",
            )
        except Exception as exc:
            cuda = BackendCapability(
                "cuda",
                False,
                "cuda",
                "float16",
                f"CUDA probe failed: {exc}",
            )
    capabilities.append(cuda)

    capabilities.append(
        BackendCapability(
            "cpu",
            faster_whisper_available,
            "cpu",
            "int8",
            None if faster_whisper_available else faster_whisper_error,
        )
    )
    return tuple(capabilities)


def available_backend_names(capabilities: tuple[BackendCapability, ...]) -> list[str]:
    return [capability.name for capability in capabilities if capability.available]


def without_disabled_backends(
    capabilities: tuple[BackendCapability, ...],
    disabled: set[str],
) -> tuple[BackendCapability, ...]:
    normalized = {name.strip().lower() for name in disabled}
    return tuple(
        BackendCapability(
            capability.name,
            False,
            capability.device,
            capability.compute_type,
            "Disabled after a native backend failure; change backend settings to retry.",
        )
        if capability.name in normalized
        else capability
        for capability in capabilities
    )


def select_backend(
    requested: RequestedBackend,
    capabilities: tuple[BackendCapability, ...],
) -> BackendName:
    by_name = {capability.name: capability for capability in capabilities}
    if requested == "auto":
        for name in BACKEND_PRIORITY:
            capability = by_name.get(name)
            if capability and capability.available:
                return name
        reasons = "; ".join(
            f"{capability.name}: {capability.reason or 'unavailable'}"
            for capability in capabilities
        )
        raise BackendUnavailableError(f"No transcription backend is available. {reasons}")

    capability = by_name.get(requested)
    if capability and capability.available:
        return requested
    reason = capability.reason if capability else "The backend probe returned no result."
    raise BackendUnavailableError(f"Requested {requested.upper()} backend is unavailable. {reason}")
