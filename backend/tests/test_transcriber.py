import sys
import types

import pytest

from app.config import Settings
from app.transcriber import WhisperTranscriber


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
