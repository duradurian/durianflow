import sys
import types

import numpy as np
import pytest

from app.config import Settings
from app.backends import BackendCapability
from app.transcriber import WhisperTranscriber, create_transcriber


def test_cuda_load_can_fallback_to_cpu(monkeypatch, tmp_path) -> None:
    calls = []

    class FakeWhisperModel:
        def __init__(self, source, **kwargs):
            calls.append((source, kwargs.copy()))
            if kwargs["device"] == "cuda":
                raise RuntimeError("cublas64_12.dll was not found")

    fake_module = types.SimpleNamespace(WhisperModel=FakeWhisperModel)
    monkeypatch.setitem(sys.modules, "faster_whisper", fake_module)
    monkeypatch.setattr("app.transcriber.configure_cuda_dll_paths", lambda: [])

    transcriber = WhisperTranscriber(
        Settings(
            _env_file=None,
            MODEL_NAME="tiny",
            MODELS_DIR=str(tmp_path),
            ALLOW_MODEL_DOWNLOAD=True,
            DEVICE="cuda",
            COMPUTE_TYPE="float16",
            FALLBACK_TO_CPU_ON_CUDA_ERROR=True,
        )
    )

    transcriber.load()

    assert len(calls) == 2
    assert calls[0][1]["device"] == "cuda"
    assert calls[1][1]["device"] == "cpu"
    assert calls[1][1]["compute_type"] == "int8"
    assert transcriber.model_loaded
    assert transcriber.active_device == "cpu"
    assert transcriber.active_compute_type == "int8"


def test_explicit_cuda_does_not_fallback_to_cpu(monkeypatch, tmp_path) -> None:
    calls = []

    class FakeWhisperModel:
        def __init__(self, source, **kwargs):
            calls.append((source, kwargs.copy()))
            raise RuntimeError("cublas64_12.dll was not found")

    monkeypatch.setitem(sys.modules, "faster_whisper", types.SimpleNamespace(WhisperModel=FakeWhisperModel))
    monkeypatch.setattr("app.transcriber.configure_cuda_dll_paths", lambda: [])
    transcriber = WhisperTranscriber(
        Settings(
            _env_file=None,
            MODEL_NAME="tiny",
            MODELS_DIR=str(tmp_path),
            ALLOW_MODEL_DOWNLOAD=True,
            DEVICE="cuda",
            COMPUTE_TYPE="float16",
            FALLBACK_TO_CPU_ON_CUDA_ERROR=False,
        )
    )

    with pytest.raises(RuntimeError, match="cublas64_12.dll"):
        transcriber.load()

    assert len(calls) == 1
    assert calls[0][1]["device"] == "cuda"
    assert not transcriber.model_loaded


def test_model_source_errors_populate_load_error(monkeypatch, tmp_path) -> None:
    fake_module = types.SimpleNamespace(WhisperModel=object)
    monkeypatch.setitem(sys.modules, "faster_whisper", fake_module)

    transcriber = WhisperTranscriber(
        Settings(
            _env_file=None,
            MODEL_NAME="missing",
            MODELS_DIR=str(tmp_path),
            ALLOW_MODEL_DOWNLOAD=False,
            DEVICE="cpu",
            COMPUTE_TYPE="int8",
        )
    )

    with pytest.raises(RuntimeError, match="Local Whisper model was not found"):
        transcriber.load()

    assert transcriber.load_error is not None
    assert "Local Whisper model was not found" in transcriber.load_error


def test_compatibility_retry_failure_still_uses_cpu_fallback(monkeypatch, tmp_path) -> None:
    calls = []

    class FakeWhisperModel:
        def __init__(self, source, **kwargs):
            calls.append(kwargs.copy())
            if "local_files_only" in kwargs:
                raise TypeError("unexpected keyword argument 'local_files_only'")
            if kwargs["device"] == "cuda":
                raise RuntimeError("cublas64_12.dll was not found")

    monkeypatch.setitem(sys.modules, "faster_whisper", types.SimpleNamespace(WhisperModel=FakeWhisperModel))
    monkeypatch.setattr("app.transcriber.configure_cuda_dll_paths", lambda: [])
    transcriber = WhisperTranscriber(Settings(
        _env_file=None,
        MODEL_NAME="tiny",
        MODELS_DIR=str(tmp_path),
        ALLOW_MODEL_DOWNLOAD=True,
        DEVICE="cuda",
        COMPUTE_TYPE="float16",
        FALLBACK_TO_CPU_ON_CUDA_ERROR=True,
    ))

    transcriber.load()

    assert [call["device"] for call in calls] == ["cuda", "cuda", "cpu", "cpu"]
    assert transcriber.active_device == "cpu"
    assert transcriber.model_loaded


def test_cuda_out_of_memory_has_specific_remediation() -> None:
    class FailingModel:
        def transcribe(self, *_args, **_kwargs):
            raise RuntimeError("CUDA failed with out of memory")

    transcriber = WhisperTranscriber(Settings(_env_file=None, DEVICE="cuda"))
    transcriber._model = FailingModel()
    transcriber.active_device = "cuda"

    with pytest.raises(RuntimeError, match="ran out of memory") as raised:
        transcriber.transcribe(np.zeros(160, dtype=np.float32), 16000, "en", "fast")

    assert "runtime libraries are missing" not in str(raised.value)


def test_transcribe_rejects_incompatible_audio_before_loading_model() -> None:
    transcriber = WhisperTranscriber(Settings(_env_file=None, DEVICE="cpu"))

    with pytest.raises(ValueError, match="16000 Hz"):
        transcriber.transcribe(np.zeros(160, dtype=np.float32), 48000, "en", "fast")
    with pytest.raises(ValueError, match="one-dimensional"):
        transcriber.transcribe(np.zeros((160, 1), dtype=np.float32), 16000, "en", "fast")
    with pytest.raises(ValueError, match="finite"):
        transcriber.transcribe(np.array([np.nan], dtype=np.float32), 16000, "en", "fast")

    assert not transcriber.model_loaded


def test_factory_preserves_explicit_direct_cuda_fallback_policy() -> None:
    capabilities = (
        BackendCapability("mlx", False, "metal", "float16", "not a Mac"),
        BackendCapability("cuda", True, "cuda", "float16"),
        BackendCapability("cpu", True, "cpu", "int8"),
    )
    transcriber = create_transcriber(
        Settings(
            _env_file=None,
            DEVICE="cuda",
            FALLBACK_TO_CPU_ON_CUDA_ERROR=True,
        ),
        capabilities,
    )

    assert isinstance(transcriber, WhisperTranscriber)
    assert transcriber.settings.FALLBACK_TO_CPU_ON_CUDA_ERROR is True


def test_factory_uses_cpu_when_direct_cuda_probe_is_unavailable_and_fallback_enabled() -> None:
    capabilities = (
        BackendCapability("mlx", False, "metal", "float16", "not a Mac"),
        BackendCapability("cuda", False, "cuda", "float16", "no CUDA device"),
        BackendCapability("cpu", True, "cpu", "int8"),
    )
    transcriber = create_transcriber(
        Settings(
            _env_file=None,
            DEVICE="cuda",
            COMPUTE_TYPE="float16",
            FALLBACK_TO_CPU_ON_CUDA_ERROR=True,
        ),
        capabilities,
    )

    assert isinstance(transcriber, WhisperTranscriber)
    assert transcriber.requested_backend == "cuda"
    assert transcriber.active_backend == "cpu"
    assert transcriber.active_compute_type == "int8"
