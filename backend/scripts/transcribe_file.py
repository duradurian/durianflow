import argparse
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.audio import ensure_mono  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.transcriber import WhisperTranscriber  # noqa: E402


def load_audio(path: Path, target_rate: int) -> np.ndarray:
    audio, sample_rate = sf.read(path, dtype="float32")
    audio = ensure_mono(audio)
    if sample_rate != target_rate:
        audio = resample_poly(audio, target_rate, sample_rate).astype(np.float32)
    return audio


def main() -> None:
    parser = argparse.ArgumentParser(description="Transcribe an audio file with the configured model.")
    parser.add_argument("path", type=Path)
    parser.add_argument("--language", default=None)
    parser.add_argument("--mode", choices=["fast", "accurate"], default="fast")
    args = parser.parse_args()

    settings = get_settings()
    transcriber = WhisperTranscriber(settings.MODEL_NAME, settings.DEVICE, settings.COMPUTE_TYPE)
    audio = load_audio(args.path, settings.SAMPLE_RATE)
    segments = transcriber.transcribe(audio, settings.SAMPLE_RATE, args.language or settings.LANGUAGE, args.mode)
    for segment in segments:
        print(f"[{segment.start:7.2f} -> {segment.end:7.2f}] {segment.text}")


if __name__ == "__main__":
    main()
