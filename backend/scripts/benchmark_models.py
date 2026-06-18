import argparse
import time

import numpy as np

from app.config import get_settings
from app.schemas import AVAILABLE_MODELS
from app.transcriber import WhisperTranscriber


def main() -> None:
    parser = argparse.ArgumentParser(description="Benchmark configured faster-whisper models locally.")
    parser.add_argument("--models", nargs="*", default=AVAILABLE_MODELS)
    parser.add_argument("--seconds", type=int, default=10)
    parser.add_argument("--mode", choices=["fast", "accurate"], default="fast")
    args = parser.parse_args()

    settings = get_settings()
    audio = np.zeros(settings.SAMPLE_RATE * args.seconds, dtype=np.float32)
    for model_name in args.models:
        transcriber = WhisperTranscriber(model_name, settings.DEVICE, settings.COMPUTE_TYPE)
        started = time.perf_counter()
        transcriber.transcribe(audio, settings.SAMPLE_RATE, settings.LANGUAGE, args.mode)
        elapsed = time.perf_counter() - started
        print(f"{model_name}: {elapsed:.2f}s for {args.seconds}s audio")


if __name__ == "__main__":
    main()
