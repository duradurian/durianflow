import gc
import importlib
import itertools
import logging
import platform
from threading import Lock
from typing import Any

import numpy as np

from app.backends import (
    BACKEND_PRIORITY,
    BackendCapability,
    BackendName,
    BackendUnavailableError,
    available_backend_names,
    detect_backend_capabilities,
    select_backend,
    without_disabled_backends,
)
from app.cuda_runtime import configure_cuda_dll_paths
from app.config import Settings
from app.model_store import ensure_mlx_model, expected_model_path, resolve_model_source
from app.schemas import TranscriptSegment

logger = logging.getLogger(__name__)


CUDA_RUNTIME_ERROR_MARKERS = (
    "cublas",
    "cudnn",
    "cuda",
    "cublas64_12.dll",
    "cudnn64",
)
CUDA_OUT_OF_MEMORY_MARKERS = (
    "out of memory",
    "cuda_error_out_of_memory",
    "failed to allocate",
)


class WhisperTranscriber:
    def __init__(
        self,
        model_name: str | Settings,
        device: str | None = None,
        compute_type: str | None = None,
    ) -> None:
        if isinstance(model_name, Settings):
            self.settings = model_name
        else:
            self.settings = Settings(
                MODEL_NAME=model_name,
                DEVICE=device or "cpu",
                COMPUTE_TYPE=compute_type or "int8",
                ALLOW_MODEL_DOWNLOAD=True,
            )
        self.model_name = self.settings.MODEL_NAME
        self.device = self.settings.DEVICE
        self.compute_type = _compute_type_for(self.device, self.settings.COMPUTE_TYPE)
        self.model_source = self.model_name
        self.active_device = self.device
        self.active_backend = self.device
        self.active_compute_type = self.compute_type
        self.requested_backend = self.settings.DEVICE
        self.capabilities: tuple[BackendCapability, ...] = ()
        self.available_backends: list[str] = []
        self._model = None
        self.load_error: str | None = None
        self._segment_counter = itertools.count(1)
        self._load_lock = Lock()

    @property
    def model_loaded(self) -> bool:
        return self._model is not None

    def load(self) -> None:
        with self._load_lock:
            if self._model is not None:
                return
            if self.device == "cuda":
                configure_cuda_dll_paths()
            try:
                from faster_whisper import WhisperModel
            except ImportError as exc:
                error = RuntimeError("faster-whisper is not installed")
                self.load_error = str(error)
                raise error from exc

            try:
                model_source, local_files_only = resolve_model_source(self.settings)
                self.model_source = model_source
                self.active_device = self.device
                self.active_compute_type = self.compute_type
                logger.info(
                    "Loading faster-whisper model %s on %s (%s)",
                    model_source,
                    self.device,
                    self.compute_type,
                )
                kwargs = {
                    "device": self.device,
                    "compute_type": self.compute_type,
                    "local_files_only": local_files_only,
                }
                if not local_files_only:
                    kwargs["download_root"] = str(expected_model_path(self.settings).parent)
                try:
                    self._load_compatible(WhisperModel, model_source, kwargs)
                except Exception as exc:
                    if not self._should_retry_on_cpu(exc):
                        raise
                    self._load_cpu_fallback(WhisperModel, model_source, local_files_only)
            except Exception as exc:
                self.load_error = str(exc)
                raise

    def _load_with_kwargs(self, model_class, model_source: str, kwargs: dict) -> None:
        self._model = model_class(model_source, **kwargs)
        self.active_device = str(kwargs.get("device", self.device))
        self.active_backend = self.active_device
        self.active_compute_type = str(kwargs.get("compute_type", self.compute_type))
        self.load_error = None

    def _load_compatible(self, model_class, model_source: str, kwargs: dict) -> None:
        try:
            self._load_with_kwargs(model_class, model_source, kwargs)
        except TypeError:
            if "local_files_only" not in kwargs:
                raise
            compatible_kwargs = dict(kwargs)
            compatible_kwargs.pop("local_files_only")
            self._load_with_kwargs(model_class, model_source, compatible_kwargs)

    def _should_retry_on_cpu(self, exc: Exception) -> bool:
        return (
            self.device == "cuda"
            and self.settings.FALLBACK_TO_CPU_ON_CUDA_ERROR
            and isinstance(exc, RuntimeError)
            and _is_cuda_runtime_error(exc)
        )

    def _load_cpu_fallback(self, model_class, model_source: str, local_files_only: bool) -> None:
        logger.warning("CUDA model load failed; retrying on CPU with int8 compute")
        kwargs = {
            "device": "cpu",
            "compute_type": "int8",
            "local_files_only": local_files_only,
        }
        if not local_files_only:
            kwargs["download_root"] = str(expected_model_path(self.settings).parent)
        self._load_compatible(model_class, model_source, kwargs)

    def transcribe(
        self,
        audio: np.ndarray,
        sample_rate: int,
        language: str | None,
        mode: str,
    ) -> list[TranscriptSegment]:
        if sample_rate != self.settings.SAMPLE_RATE:
            raise ValueError(f"Expected {self.settings.SAMPLE_RATE} Hz audio")
        if mode not in {"fast", "accurate"}:
            raise ValueError("mode must be 'fast' or 'accurate'")
        normalized_audio = np.asarray(audio, dtype=np.float32)
        if normalized_audio.ndim != 1:
            raise ValueError("audio must be a one-dimensional mono array")
        if len(normalized_audio) == 0:
            return []
        if not np.all(np.isfinite(normalized_audio)):
            raise ValueError("audio must contain only finite samples")
        if self._model is None:
            self.load()

        try:
            beam_size = 1 if mode == "fast" else 3
            segments, _info = self._model.transcribe(
                normalized_audio,
                language=language,
                beam_size=beam_size,
                temperature=0,
                vad_filter=False,
                word_timestamps=False,
            )
            output: list[TranscriptSegment] = []
            for segment in segments:
                output.append(
                    TranscriptSegment(
                        id=f"seg_{next(self._segment_counter):06d}",
                        start=float(segment.start),
                        end=float(segment.end),
                        text=segment.text.strip(),
                    )
                )
            return output
        except RuntimeError as exc:
            if self.active_device == "cuda" and _is_cuda_out_of_memory_error(exc):
                raise RuntimeError(
                    "CUDA ran out of memory during transcription. "
                    "Close other GPU workloads, choose a smaller model, or switch to CPU mode. "
                    f"Original error: {exc}"
                ) from exc
            if self.active_device == "cuda" and _is_cuda_runtime_error(exc):
                raise RuntimeError(_cuda_runtime_help(str(exc))) from exc
            raise


class MlxWhisperTranscriber:
    """MLX/Metal Whisper adapter for native Apple Silicon inference."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.model_name = settings.MODEL_NAME
        self.model_source = self.model_name
        self.device = "metal"
        self.compute_type = "float16"
        self.active_backend = "mlx"
        self.active_device = "metal"
        self.active_compute_type = "float16"
        self.requested_backend = settings.DEVICE
        self.capabilities: tuple[BackendCapability, ...] = ()
        self.available_backends: list[str] = []
        self._model: object | None = None
        self._transcribe_function = None
        self._segment_counter = itertools.count(1)
        self._load_lock = Lock()
        self.load_error: str | None = None

    @property
    def model_loaded(self) -> bool:
        return self._model is not None and self._transcribe_function is not None

    def load(self) -> None:
        with self._load_lock:
            if self.model_loaded:
                return
            try:
                mx = importlib.import_module("mlx.core")
                metal = getattr(mx, "metal", None)
                if metal is None or not metal.is_available():
                    raise BackendUnavailableError(
                        "MLX is installed, but its Metal backend is unavailable. "
                        "Use native arm64 Python on Apple Silicon with macOS 14 or newer."
                    )
                gpu = getattr(mx, "gpu", None)
                if gpu is not None and hasattr(mx, "set_default_device"):
                    mx.set_default_device(gpu)

                self.model_source = ensure_mlx_model(self.settings)
                module = importlib.import_module("mlx_whisper.transcribe")
                holder = getattr(module, "ModelHolder", None)
                if holder is None or not hasattr(holder, "get_model"):
                    raise RuntimeError(
                        "Installed mlx-whisper is incompatible with Durianflow; expected ModelHolder."
                    )
                logger.info("Loading MLX Whisper model %s on Metal", self.model_source)
                self._model = holder.get_model(self.model_source, mx.float16)
                self._transcribe_function = module.transcribe
                # Exercise the public path once so model_state=ready means the
                # Metal kernels and decoder are usable, not only that weights
                # could be read from disk.
                self._transcribe_function(
                    np.zeros(1600, dtype=np.float32),
                    path_or_hf_repo=self.model_source,
                    language=self.settings.LANGUAGE or "en",
                    beam_size=1,
                    temperature=0,
                    verbose=None,
                    word_timestamps=False,
                )
                self.load_error = None
            except Exception as exc:
                holder = locals().get("holder")
                if holder is not None:
                    try:
                        holder.model = None
                        holder.model_path = None
                    except Exception:
                        pass
                mx = locals().get("mx")
                if mx is not None and hasattr(mx, "clear_cache"):
                    try:
                        mx.clear_cache()
                    except Exception:
                        pass
                self._model = None
                self._transcribe_function = None
                self.load_error = str(exc)
                gc.collect()
                raise

    def transcribe(
        self,
        audio: np.ndarray,
        sample_rate: int,
        language: str | None,
        mode: str,
    ) -> list[TranscriptSegment]:
        normalized_audio = _validate_audio(audio, sample_rate, mode, self.settings.SAMPLE_RATE)
        if len(normalized_audio) == 0:
            return []
        if not self.model_loaded:
            self.load()
        assert self._transcribe_function is not None

        beam_size = 1 if mode == "fast" else 3
        try:
            result = self._transcribe_function(
                normalized_audio,
                path_or_hf_repo=self.model_source,
                language=language,
                beam_size=beam_size,
                temperature=0,
                verbose=None,
                word_timestamps=False,
            )
        except Exception as exc:
            message = str(exc).lower()
            if "out of memory" in message or "iogpu" in message:
                raise RuntimeError(
                    "MLX Metal ran out of unified memory during transcription. "
                    "Close memory-heavy apps or choose a smaller speech model. "
                    f"Original error: {exc}"
                ) from exc
            raise

        output: list[TranscriptSegment] = []
        for raw_segment in result.get("segments", []):
            if not isinstance(raw_segment, dict):
                continue
            text = str(raw_segment.get("text", "")).strip()
            start = max(0.0, float(raw_segment.get("start", 0.0)))
            end = max(start, float(raw_segment.get("end", start)))
            output.append(
                TranscriptSegment(
                    id=f"seg_{next(self._segment_counter):06d}",
                    start=start,
                    end=end,
                    text=text,
                )
            )
        return output


class UnavailableTranscriber:
    def __init__(
        self,
        settings: Settings,
        capabilities: tuple[BackendCapability, ...],
        error: Exception,
    ) -> None:
        self.settings = settings
        self.model_name = settings.MODEL_NAME
        self.model_source = settings.MODEL_NAME
        self.requested_backend = settings.DEVICE
        self.active_backend = "unavailable"
        self.active_device = "unavailable"
        self.active_compute_type = "unavailable"
        self.capabilities = capabilities
        self.available_backends = available_backend_names(capabilities)
        self.load_error = str(error)
        self._error = error

    @property
    def model_loaded(self) -> bool:
        return False

    def load(self) -> None:
        raise self._error

    def transcribe(self, *_args: Any, **_kwargs: Any) -> list[TranscriptSegment]:
        raise self._error


class AutoTranscriber:
    """Try available engines in priority order until one model loads."""

    def __init__(
        self,
        settings: Settings,
        capabilities: tuple[BackendCapability, ...],
    ) -> None:
        self.settings = settings
        self.model_name = settings.MODEL_NAME
        self.model_source = settings.MODEL_NAME
        self.requested_backend = "auto"
        self.capabilities = capabilities
        self.available_backends = available_backend_names(capabilities)
        first = next((name for name in BACKEND_PRIORITY if name in self.available_backends), None)
        self.active_backend = first or "unavailable"
        self.active_device = "metal" if first == "mlx" else first or "unavailable"
        self.active_compute_type = _compute_type_for(first or "cpu", "auto")
        self.load_error: str | None = None
        self._delegate: WhisperTranscriber | MlxWhisperTranscriber | None = None
        self._load_lock = Lock()

    @property
    def model_loaded(self) -> bool:
        return bool(self._delegate and self._delegate.model_loaded)

    def _sync(self, delegate: WhisperTranscriber | MlxWhisperTranscriber) -> None:
        self.model_source = delegate.model_source
        self.active_backend = delegate.active_backend
        self.active_device = delegate.active_device
        self.active_compute_type = delegate.active_compute_type
        self.load_error = delegate.load_error

    def load(self) -> None:
        with self._load_lock:
            if self.model_loaded:
                return
            errors: list[str] = []
            for name in BACKEND_PRIORITY:
                if name not in self.available_backends:
                    continue
                delegate = _build_backend_transcriber(
                    self.settings,
                    name,
                    self.capabilities,
                    requested="auto",
                )
                self.active_backend = delegate.active_backend
                self.active_device = delegate.active_device
                self.active_compute_type = delegate.active_compute_type
                try:
                    delegate.load()
                except Exception as exc:
                    logger.warning("Automatic %s backend load failed: %s", name, exc)
                    errors.append(f"{name}: {exc}")
                    continue
                self._delegate = delegate
                self._sync(delegate)
                return
            self.load_error = "; ".join(errors) or "No transcription backend is available."
            raise BackendUnavailableError(
                f"Automatic backend selection could not load a speech model. {self.load_error}"
            )

    def transcribe(
        self,
        audio: np.ndarray,
        sample_rate: int,
        language: str | None,
        mode: str,
    ) -> list[TranscriptSegment]:
        if self._delegate is None:
            self.load()
        assert self._delegate is not None
        result = self._delegate.transcribe(audio, sample_rate, language, mode)
        self._sync(self._delegate)
        return result


def _build_backend_transcriber(
    settings: Settings,
    backend: BackendName,
    capabilities: tuple[BackendCapability, ...],
    *,
    requested: str,
) -> WhisperTranscriber | MlxWhisperTranscriber:
    if backend == "mlx":
        delegate: WhisperTranscriber | MlxWhisperTranscriber = MlxWhisperTranscriber(settings)
    else:
        configured_compute = _compute_type_for(backend, settings.COMPUTE_TYPE)
        backend_settings = settings.model_copy(
            update={
                "DEVICE": backend,
                "COMPUTE_TYPE": configured_compute,
                # AutoTranscriber owns automatic fallback. Explicit direct
                # workers preserve their configured compatibility policy; the
                # desktop sets this false whenever the user pins CUDA.
                "FALLBACK_TO_CPU_ON_CUDA_ERROR": (
                    False
                    if requested == "auto"
                    else settings.FALLBACK_TO_CPU_ON_CUDA_ERROR
                ),
            }
        )
        delegate = WhisperTranscriber(backend_settings)
    delegate.requested_backend = requested
    delegate.capabilities = capabilities
    delegate.available_backends = available_backend_names(capabilities)
    return delegate


def create_transcriber(
    settings: Settings,
    capabilities: tuple[BackendCapability, ...] | None = None,
) -> AutoTranscriber | WhisperTranscriber | MlxWhisperTranscriber | UnavailableTranscriber:
    if capabilities is None:
        capabilities = detect_backend_capabilities()
    disabled = {
        name.strip().lower()
        for name in settings.DISABLED_BACKENDS.split(",")
        if name.strip()
    }
    if disabled:
        capabilities = without_disabled_backends(capabilities, disabled)
    if settings.DEVICE == "auto":
        try:
            select_backend("auto", capabilities)
        except BackendUnavailableError as exc:
            return UnavailableTranscriber(settings, capabilities, exc)
        return AutoTranscriber(settings, capabilities)
    try:
        backend = select_backend(settings.DEVICE, capabilities)
    except BackendUnavailableError as exc:
        by_name = {capability.name: capability for capability in capabilities}
        if (
            settings.DEVICE == "cuda"
            and settings.FALLBACK_TO_CPU_ON_CUDA_ERROR
            and by_name.get("cpu")
            and by_name["cpu"].available
        ):
            logger.warning("CUDA probe unavailable; using configured CPU compatibility fallback")
            fallback_settings = settings.model_copy(
                update={"COMPUTE_TYPE": "int8", "FALLBACK_TO_CPU_ON_CUDA_ERROR": False}
            )
            return _build_backend_transcriber(
                fallback_settings,
                "cpu",
                capabilities,
                requested="cuda",
            )
        return UnavailableTranscriber(settings, capabilities, exc)
    return _build_backend_transcriber(
        settings,
        backend,
        capabilities,
        requested=settings.DEVICE,
    )


def _compute_type_for(device: str, configured: str) -> str:
    if configured != "auto":
        return configured
    return "float16" if device in {"mlx", "cuda"} else "int8"


def _validate_audio(
    audio: np.ndarray,
    sample_rate: int,
    mode: str,
    expected_sample_rate: int,
) -> np.ndarray:
    if sample_rate != expected_sample_rate:
        raise ValueError(f"Expected {expected_sample_rate} Hz audio")
    if mode not in {"fast", "accurate"}:
        raise ValueError("mode must be 'fast' or 'accurate'")
    normalized_audio = np.asarray(audio, dtype=np.float32)
    if normalized_audio.ndim != 1:
        raise ValueError("audio must be a one-dimensional mono array")
    if not np.all(np.isfinite(normalized_audio)):
        raise ValueError("audio must contain only finite samples")
    return normalized_audio


def _is_cuda_runtime_error(exc: RuntimeError) -> bool:
    message = str(exc).lower()
    return any(marker in message for marker in CUDA_RUNTIME_ERROR_MARKERS)


def _is_cuda_out_of_memory_error(exc: RuntimeError) -> bool:
    message = str(exc).lower()
    return "cuda" in message and any(marker in message for marker in CUDA_OUT_OF_MEMORY_MARKERS)


def _cuda_runtime_help(original_message: str) -> str:
    if platform.system() == "Windows":
        return (
            "CUDA runtime libraries are missing or not visible to Python. "
            f"Original error: {original_message}. "
            "For NVIDIA GPU mode on Windows, install NVIDIA CUDA Toolkit 12.x and cuDNN for CUDA 12, "
            "then make sure their bin directories are on PATH before starting Durianflow. "
            "At minimum, cublas64_12.dll must be discoverable. Restart the terminal after changing PATH."
        )
    return (
        "CUDA runtime libraries are missing or not visible to Python. "
        f"Original error: {original_message}. "
        "Install CUDA 12.x and cuDNN on the host."
    )
