from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.backends import detect_backend_capabilities, select_backend  # noqa: E402
from app.model_store import (  # noqa: E402
    MODEL_FILE_REQUIREMENTS,
    MLX_MODEL_FILE_REQUIREMENTS,
    is_valid_model_dir,
    is_valid_mlx_model_dir,
    is_link_or_junction,
    mlx_model_repository,
    model_dir_name,
    remove_managed_path,
    validate_managed_path,
)


def resolve_models_dir(value: str) -> Path:
    path = Path(value).expanduser()
    if path.is_absolute():
        return Path(os.path.abspath(path))
    return Path(os.path.abspath(ROOT / path))


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Install an MLX or faster-whisper model for offline Durianflow startup."
    )
    parser.add_argument("model", nargs="?", default="large-v3-turbo", help="Model name or Hugging Face repo id.")
    parser.add_argument("--models-dir", default="./models", help="Directory where local models are stored.")
    parser.add_argument("--force", action="store_true", help="Replace an existing incomplete or stale model directory.")
    parser.add_argument(
        "--backend",
        choices=("auto", "mlx", "cuda", "cpu"),
        default="auto",
        help="Model format to install; auto uses the best backend available on this computer.",
    )
    args = parser.parse_args()

    backend = select_backend(args.backend, detect_backend_capabilities())
    models_dir = resolve_models_dir(args.models_dir)
    target_name = model_dir_name(args.model)
    if backend == "mlx":
        target_name = f"mlx--{target_name}"
    target = models_dir / target_name
    temp = models_dir / f".{target.name}.tmp"
    validate_managed_path(models_dir, target)
    validate_managed_path(models_dir, temp)
    models_dir.mkdir(parents=True, exist_ok=True)
    valid_model = is_valid_mlx_model_dir if backend == "mlx" else is_valid_model_dir
    requirements = MLX_MODEL_FILE_REQUIREMENTS if backend == "mlx" else MODEL_FILE_REQUIREMENTS

    if valid_model(target):
        print(f"Model already installed at {target}")
        return
    if (target.exists() or is_link_or_junction(target)) and not args.force:
        raise SystemExit(
            f"Model directory exists but is incomplete: {target}\n"
            "Re-run with --force to replace it."
        )

    if temp.exists() or is_link_or_junction(temp):
        remove_managed_path(models_dir, temp)
    if (target.exists() or is_link_or_junction(target)) and args.force:
        remove_managed_path(models_dir, target)
    temp.mkdir(parents=True)

    print(f"Installing {args.model} for {backend} into {target}")
    if backend == "mlx":
        try:
            from huggingface_hub import snapshot_download
        except ImportError as exc:
            raise SystemExit(
                "huggingface-hub is not installed. Run backend dependency setup first."
            ) from exc
        downloaded = snapshot_download(
            repo_id=mlx_model_repository(args.model),
            local_dir=str(temp),
        )
    else:
        try:
            from faster_whisper.utils import download_model
        except ImportError as exc:
            raise SystemExit(
                "faster-whisper is not installed. Run backend dependency setup before installing models."
            ) from exc
        try:
            downloaded = download_model(args.model, output_dir=str(temp), local_files_only=False)
        except TypeError:
            downloaded = download_model(args.model, cache_dir=str(temp), local_files_only=False)

    resolved = Path(downloaded).expanduser().resolve() if downloaded else temp
    if not valid_model(resolved):
        raise SystemExit(
            f"Downloaded model at {resolved} is incomplete. Expected {requirements}."
        )
    if resolved != temp:
        if target.exists() or is_link_or_junction(target):
            remove_managed_path(models_dir, target)
        shutil.copytree(resolved, target)
        remove_managed_path(models_dir, temp)
    else:
        temp.replace(target)

    if not valid_model(target):
        raise SystemExit(
            f"Downloaded model at {target} is incomplete. Expected {requirements}."
        )

    print("\nModel installed.")
    print("Add or keep these values in backend/.env:")
    print(f"MODEL_NAME={args.model}")
    print(f"DEVICE={backend}")
    print(f"{'MLX_MODEL_PATH' if backend == 'mlx' else 'MODEL_PATH'}={target}")
    print("ALLOW_MODEL_DOWNLOAD=false")


if __name__ == "__main__":
    main()
