import types

import numpy as np

from app.config import Settings
from app.transcriber import MlxWhisperTranscriber


def test_mlx_transcriber_loads_once_and_normalizes_segments(monkeypatch, tmp_path) -> None:
    calls = {"load": 0, "transcribe": []}
    selected_devices = []

    class ModelHolder:
        @classmethod
        def get_model(cls, source, dtype):
            calls["load"] += 1
            assert source == str(tmp_path / "mlx-model")
            assert dtype == "float16"
            return object()

    def transcribe(audio, **kwargs):
        calls["transcribe"].append((audio.copy(), kwargs))
        return {
            "segments": [
                {"start": 0.1, "end": 0.5, "text": " hello "},
                {"start": 0.5, "end": 0.9, "text": "world"},
            ]
        }

    mx = types.SimpleNamespace(
        metal=types.SimpleNamespace(is_available=lambda: True),
        gpu="gpu",
        float16="float16",
        set_default_device=selected_devices.append,
    )
    module = types.SimpleNamespace(ModelHolder=ModelHolder, transcribe=transcribe)
    monkeypatch.setattr("app.transcriber.ensure_mlx_model", lambda _settings: str(tmp_path / "mlx-model"))
    monkeypatch.setattr(
        "app.transcriber.importlib.import_module",
        lambda name: mx if name == "mlx.core" else module,
    )

    backend = MlxWhisperTranscriber(
        Settings(_env_file=None, DEVICE="mlx", MODEL_NAME="small")
    )
    backend.load()
    backend.load()
    segments = backend.transcribe(
        np.zeros(1600, dtype=np.float32),
        16000,
        "en",
        "accurate",
    )

    assert calls["load"] == 1
    assert selected_devices == ["gpu"]
    assert [segment.text for segment in segments] == ["hello", "world"]
    assert len(calls["transcribe"]) == 2
    assert calls["transcribe"][-1][1]["beam_size"] == 3
    assert backend.active_backend == "mlx"
    assert backend.active_device == "metal"


def test_mlx_warmup_failure_releases_cached_model(monkeypatch, tmp_path) -> None:
    cleared = []

    class ModelHolder:
        model = None
        model_path = None

        @classmethod
        def get_model(cls, source, _dtype):
            cls.model = object()
            cls.model_path = source
            return cls.model

    def transcribe(_audio, **_kwargs):
        raise RuntimeError("Metal warmup failed")

    mx = types.SimpleNamespace(
        metal=types.SimpleNamespace(is_available=lambda: True),
        gpu="gpu",
        float16="float16",
        set_default_device=lambda _device: None,
        clear_cache=lambda: cleared.append(True),
    )
    module = types.SimpleNamespace(ModelHolder=ModelHolder, transcribe=transcribe)
    monkeypatch.setattr("app.transcriber.ensure_mlx_model", lambda _settings: str(tmp_path / "mlx-model"))
    monkeypatch.setattr(
        "app.transcriber.importlib.import_module",
        lambda name: mx if name == "mlx.core" else module,
    )

    backend = MlxWhisperTranscriber(Settings(_env_file=None, DEVICE="mlx"))

    try:
        backend.load()
    except RuntimeError as exc:
        assert "Metal warmup failed" in str(exc)
    else:
        raise AssertionError("MLX warmup failure should be raised")

    assert ModelHolder.model is None
    assert ModelHolder.model_path is None
    assert backend.model_loaded is False
    assert cleared == [True]
