import math

import numpy as np


def pcm16_bytes_to_float32(data: bytes) -> np.ndarray:
    if len(data) % 2 != 0:
        raise ValueError("PCM16 byte payload length must be divisible by 2")
    pcm = np.frombuffer(data, dtype="<i2")
    return (pcm.astype(np.float32) / 32768.0).clip(-1.0, 1.0)


def float32_to_pcm16(audio: np.ndarray) -> bytes:
    clipped = np.asarray(audio, dtype=np.float32).clip(-1.0, 1.0)
    pcm = (clipped * 32767.0).astype("<i2")
    return pcm.tobytes()


def ensure_mono(audio: np.ndarray) -> np.ndarray:
    arr = np.asarray(audio)
    if arr.ndim == 1:
        return arr.astype(np.float32, copy=False)
    if arr.ndim == 2:
        return arr.mean(axis=1).astype(np.float32, copy=False)
    raise ValueError("Audio must be 1D mono or 2D multi-channel")


def seconds_to_samples(seconds: float, sample_rate: int) -> int:
    if sample_rate <= 0:
        raise ValueError("sample_rate must be positive")
    if not math.isfinite(seconds):
        raise ValueError("seconds must be finite")
    return max(0, int(round(seconds * sample_rate)))


def samples_to_seconds(samples: int, sample_rate: int) -> float:
    if sample_rate <= 0:
        raise ValueError("sample_rate must be positive")
    return samples / sample_rate


def trim_or_pad(audio: np.ndarray, sample_rate: int, max_seconds: float) -> np.ndarray:
    max_samples = seconds_to_samples(max_seconds, sample_rate)
    arr = ensure_mono(audio)
    if max_samples == 0:
        return np.empty(0, dtype=arr.dtype)
    if len(arr) > max_samples:
        return arr[-max_samples:]
    if len(arr) < max_samples:
        return np.pad(arr, (0, max_samples - len(arr)))
    return arr
