import numpy as np
import pytest

from app.audio import (
    ensure_mono,
    float32_to_pcm16,
    pcm16_bytes_to_float32,
    samples_to_seconds,
    seconds_to_samples,
    trim_or_pad,
)


def test_pcm16_roundtrip() -> None:
    audio = np.array([-1.0, -0.5, 0.0, 0.5, 1.0], dtype=np.float32)
    decoded = pcm16_bytes_to_float32(float32_to_pcm16(audio))
    assert np.allclose(decoded, audio, atol=1 / 32768)


def test_pcm16_rejects_odd_payload() -> None:
    with pytest.raises(ValueError):
        pcm16_bytes_to_float32(b"\x00")


def test_ensure_mono_averages_channels() -> None:
    stereo = np.array([[1.0, -1.0], [0.5, 0.25]], dtype=np.float32)
    assert np.allclose(ensure_mono(stereo), np.array([0.0, 0.375], dtype=np.float32))


def test_trim_or_pad() -> None:
    audio = np.ones(5, dtype=np.float32)
    assert len(trim_or_pad(audio, 10, 1)) == 10
    assert len(trim_or_pad(np.ones(20, dtype=np.float32), 10, 1)) == 10


def test_sample_time_helpers() -> None:
    assert seconds_to_samples(0.5, 16000) == 8000
    assert samples_to_seconds(8000, 16000) == 0.5
