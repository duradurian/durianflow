import argparse
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import Settings, get_settings  # noqa: E402
from app.transcriber import create_transcriber  # noqa: E402


def positive_seconds(value: str) -> int:
    seconds = int(value)
    if seconds <= 0:
        raise argparse.ArgumentTypeError("seconds must be a positive integer")
    return seconds


def main() -> None:
    parser = argparse.ArgumentParser(description="Benchmark configured faster-whisper models locally.")
    parser.add_argument("--models", nargs="*")
    parser.add_argument("--seconds", type=positive_seconds, default=10)
    parser.add_argument("--mode", choices=["fast", "accurate"], default="fast")
    parser.add_argument("--backend", choices=["auto", "mlx", "cuda", "cpu"], default=None)
    args = parser.parse_args()

    settings = get_settings()
    audio = np.zeros(settings.SAMPLE_RATE * args.seconds, dtype=np.float32)
    for model_name in args.models or [settings.MODEL_NAME]:
        model_settings = Settings(
            MODEL_NAME=model_name,
            MODELS_DIR=settings.MODELS_DIR,
            DEVICE=args.backend or settings.DEVICE,
            COMPUTE_TYPE=settings.COMPUTE_TYPE,
            LANGUAGE=settings.LANGUAGE,
            ALLOW_MODEL_DOWNLOAD=settings.ALLOW_MODEL_DOWNLOAD,
        )
        transcriber = create_transcriber(model_settings)
        started = time.perf_counter()
        transcriber.transcribe(audio, settings.SAMPLE_RATE, settings.LANGUAGE, args.mode)
        elapsed = time.perf_counter() - started
        print(
            f"{model_name} [{transcriber.active_backend}/{transcriber.active_compute_type}]: "
            f"{elapsed:.2f}s for {args.seconds}s audio"
        )


if __name__ == "__main__":
    main()
