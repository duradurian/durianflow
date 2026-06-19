from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.model_store import is_valid_model_dir, model_dir_name


def resolve_models_dir(value: str) -> Path:
    path = Path(value).expanduser()
    if path.is_absolute():
        return path
    return (ROOT / path).resolve()


def main() -> None:
    parser = argparse.ArgumentParser(description="Install a faster-whisper model for offline Openflow startup.")
    parser.add_argument("model", nargs="?", default="large-v3-turbo", help="Model name or Hugging Face repo id.")
    parser.add_argument("--models-dir", default="./models", help="Directory where local models are stored.")
    parser.add_argument("--force", action="store_true", help="Replace an existing incomplete or stale model directory.")
    args = parser.parse_args()

    models_dir = resolve_models_dir(args.models_dir)
    target = models_dir / model_dir_name(args.model)
    temp = models_dir / f".{target.name}.tmp"
    models_dir.mkdir(parents=True, exist_ok=True)

    if is_valid_model_dir(target):
        print(f"Model already installed at {target}")
        return
    if target.exists() and not args.force:
        raise SystemExit(
            f"Model directory exists but is incomplete: {target}\n"
            "Re-run with --force to replace it."
        )

    try:
        from faster_whisper.utils import download_model
    except ImportError as exc:
        raise SystemExit(
            "faster-whisper is not installed. Run backend dependency setup before installing models."
        ) from exc

    if temp.exists():
        shutil.rmtree(temp)
    if target.exists() and args.force:
        shutil.rmtree(target)
    temp.mkdir(parents=True)

    print(f"Installing {args.model} into {target}")
    try:
        downloaded = download_model(args.model, output_dir=str(temp), local_files_only=False)
    except TypeError:
        downloaded = download_model(args.model, cache_dir=str(temp), local_files_only=False)

    resolved = Path(downloaded).expanduser().resolve() if downloaded else temp
    if resolved != temp:
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(resolved, target)
        shutil.rmtree(temp, ignore_errors=True)
    else:
        temp.replace(target)

    if not is_valid_model_dir(target):
        raise SystemExit(
            f"Downloaded model at {target} is incomplete. Expected model.bin and config.json."
        )

    print("\nModel installed.")
    print("Add or keep these values in backend/.env:")
    print(f"MODEL_NAME={args.model}")
    print(f"MODEL_PATH={target}")
    print("ALLOW_MODEL_DOWNLOAD=false")


if __name__ == "__main__":
    main()
