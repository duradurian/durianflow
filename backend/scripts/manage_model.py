"""Manage local faster-whisper model profiles for the Electron client.

With ``--json`` stdout is newline-delimited JSON only.  This gives the Electron
main process a bounded, parseable control channel for status, cleanup, download,
and delete operations while keeping model files outside renderer reach.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import threading
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import Settings, get_settings  # noqa: E402
from app.backends import detect_backend_capabilities, select_backend  # noqa: E402
from app.model_store import (  # noqa: E402
    cached_model_snapshot,
    expected_model_path,
    expected_mlx_model_path,
    is_valid_model_dir,
    is_valid_mlx_model_dir,
    is_link_or_junction,
    MLX_MODEL_FILE_REQUIREMENTS,
    model_cache_path,
    model_dir_name,
    model_repository,
    mlx_model_repository,
    remove_managed_path,
    MODEL_FILE_REQUIREMENTS,
    validate_managed_path,
    validate_managed_root,
)
from app.schemas import AVAILABLE_MODELS  # noqa: E402


def emit(payload: dict[str, Any], json_output: bool) -> None:
    if json_output:
        print(json.dumps(payload, separators=(",", ":")), flush=True)
    else:
        print(payload.get("message") or payload.get("type", "status"), flush=True)


def profile_settings(model_name: str) -> Settings:
    """Profiles always use the managed model directory, never an external path."""
    return Settings(MODEL_NAME=model_name, MODEL_PATH=None, MLX_MODEL_PATH=None)


def resolved_backend(requested: str | None = None) -> str:
    selection = requested or get_settings().DEVICE
    if selection != "auto":
        return selection
    return select_backend(selection, detect_backend_capabilities())


def directory_size(path: Path) -> int:
    if not path.exists():
        return 0
    total = 0
    try:
        for item in path.rglob("*"):
            if item.is_file():
                try:
                    total += item.stat().st_size
                except OSError:
                    pass
    except OSError:
        pass
    return total


def models_dir(settings: Settings) -> Path:
    configured = Path(settings.MODELS_DIR).expanduser()
    if not configured.is_absolute():
        configured = ROOT / configured
    # Preserve the lexical root so the destructive-path guard can detect a
    # configured symlink/junction instead of silently dereferencing it.
    return Path(os.path.abspath(configured))


def cache_dir(settings: Settings) -> Path:
    return model_cache_path(settings)


def cache_snapshot(path: Path) -> Path | None:
    return cached_model_snapshot(path)


def managed_paths(settings: Settings, backend: str = "cpu") -> tuple[Path, Path | None]:
    if backend == "mlx":
        return expected_mlx_model_path(settings), None
    return expected_model_path(settings), cache_dir(settings)


def remote_size_bytes(model_name: str, backend: str = "cpu") -> int | None:
    """Return a best-effort Hub file total. Offline status still succeeds."""
    try:
        from huggingface_hub import HfApi

        repository = (
            mlx_model_repository(model_name)
            if backend == "mlx"
            else model_repository(model_name)
        )
        info = HfApi().model_info(repository, files_metadata=True)
        sizes = [getattr(item, "size", None) for item in getattr(info, "siblings", [])]
        total = sum(size for size in sizes if isinstance(size, int) and size > 0)
        return total or None
    except Exception:
        return None


def status(
    model_name: str,
    include_remote: bool = False,
    backend: str = "cpu",
) -> dict[str, Any]:
    settings = profile_settings(model_name)
    target, cache = managed_paths(settings, backend)
    if backend == "mlx":
        installed_path = target if is_valid_mlx_model_dir(target) else None
        repository = mlx_model_repository(model_name)
    else:
        installed_path = target if is_valid_model_dir(target) else cache_snapshot(cache)
        repository = model_repository(model_name)
    storage_path = installed_path or target
    downloaded = directory_size(installed_path or cache or target)
    root = models_dir(settings)
    try:
        disk = shutil.disk_usage(root if root.exists() else root.parent)
        free_bytes = disk.free
    except OSError:
        free_bytes = None
    return {
        "type": "status",
        "backend": backend,
        "model": model_name,
        "repository": repository,
        "installed": installed_path is not None,
        "path": str(storage_path),
        "sizeBytes": directory_size(installed_path) if installed_path else 0,
        "downloadedBytes": downloaded,
        "totalBytes": (
            remote_size_bytes(model_name, backend)
            if include_remote and not installed_path
            else None
        ),
        "freeBytes": free_bytes,
        "message": "Installed" if installed_path else "Not installed",
        "canDelete": installed_path is not None,
    }


def cleanup_incomplete_downloads() -> dict[str, Any]:
    """Remove only stale temporary or incomplete managed-model directories."""
    root = validate_managed_root(models_dir(get_settings()))
    removed: list[str] = []
    removed_bytes = 0
    if not root.exists():
        return {"type": "cleanup", "removed": removed, "removedBytes": removed_bytes, "message": "No incomplete downloads found"}
    direct_names = {model_dir_name(model_name) for model_name in AVAILABLE_MODELS}
    mlx_names = {f"mlx--{model_dir_name(model_name)}" for model_name in AVAILABLE_MODELS}
    cache_names = {cache_dir(profile_settings(model_name)).name for model_name in AVAILABLE_MODELS}
    temporary_names = {
        f".{name}{suffix}"
        for name in direct_names | mlx_names
        for suffix in (".download", ".tmp")
    }
    for candidate in root.iterdir():
        if not candidate.is_dir() or is_link_or_junction(candidate):
            continue
        is_temporary = candidate.name in temporary_names
        is_incomplete_cache = candidate.name in cache_names and cache_snapshot(candidate) is None
        is_incomplete_direct = (
            candidate.name in direct_names
            and not is_valid_model_dir(candidate)
        )
        is_incomplete_mlx = (
            candidate.name in mlx_names
            and not is_valid_mlx_model_dir(candidate)
        )
        if not (
            is_temporary
            or is_incomplete_cache
            or is_incomplete_direct
            or is_incomplete_mlx
        ):
            continue
        removed_bytes += directory_size(candidate)
        remove_managed_path(root, candidate)
        removed.append(str(candidate))
    return {
        "type": "cleanup",
        "removed": removed,
        "removedBytes": removed_bytes,
        "message": "Removed incomplete download data" if removed else "No incomplete downloads found",
    }


def download(model_name: str, json_output: bool, backend: str = "cpu") -> dict[str, Any]:
    cleanup_incomplete_downloads()
    settings = profile_settings(model_name)
    current = status(model_name, include_remote=True, backend=backend)
    if current["installed"]:
        current.update({"type": "complete", "message": "Model is already installed"})
        emit(current, json_output)
        return current

    target, _cache = managed_paths(settings, backend)
    temporary = target.parent / f".{target.name}.download"
    validate_managed_path(target.parent, target)
    validate_managed_path(target.parent, temporary)
    target.parent.mkdir(parents=True, exist_ok=True)
    if temporary.exists() or is_link_or_junction(temporary):
        remove_managed_path(target.parent, temporary)
    temporary.mkdir()

    total_bytes = current.get("totalBytes")
    started = time.monotonic()
    stop_monitor = threading.Event()

    def progress() -> None:
        previous_bytes = 0
        previous_time = started
        while not stop_monitor.wait(0.5):
            now = time.monotonic()
            downloaded = directory_size(temporary)
            elapsed = max(now - previous_time, 0.001)
            speed = max(0, downloaded - previous_bytes) / elapsed
            emit({
                "type": "progress",
                "backend": backend,
                "model": model_name,
                "downloadedBytes": downloaded,
                "totalBytes": total_bytes,
                "speedBytesPerSecond": speed,
                "elapsedSeconds": now - started,
            }, json_output)
            previous_bytes, previous_time = downloaded, now

    emit({
        "type": "started",
        "backend": backend,
        "model": model_name,
        "downloadedBytes": 0,
        "totalBytes": total_bytes,
        "message": "Starting model download",
    }, json_output)
    monitor = threading.Thread(target=progress, name="model-download-progress", daemon=True)
    monitor.start()
    try:
        if backend == "mlx":
            from huggingface_hub import snapshot_download

            snapshot_download(
                repo_id=mlx_model_repository(model_name),
                local_dir=str(temporary),
            )
            resolved = temporary
            valid_model = is_valid_mlx_model_dir
            requirements = MLX_MODEL_FILE_REQUIREMENTS
        else:
            from faster_whisper.utils import download_model

            try:
                downloaded_path = download_model(
                    model_name,
                    output_dir=str(temporary),
                    local_files_only=False,
                )
            except TypeError:
                downloaded_path = download_model(
                    model_name,
                    cache_dir=str(temporary),
                    local_files_only=False,
                )
            resolved = Path(downloaded_path).expanduser().resolve() if downloaded_path else temporary
            valid_model = is_valid_model_dir
            requirements = MODEL_FILE_REQUIREMENTS
        if not valid_model(resolved):
            raise RuntimeError(f"Downloaded model is incomplete; expected {requirements}.")
        if target.exists() or is_link_or_junction(target):
            remove_managed_path(target.parent, target)
        if resolved != temporary:
            shutil.copytree(resolved, target)
            remove_managed_path(target.parent, temporary)
        else:
            temporary.replace(target)
        if not valid_model(target):
            raise RuntimeError(f"Downloaded model is incomplete; expected {requirements}.")
    finally:
        stop_monitor.set()
        monitor.join(timeout=1)

    result = status(model_name, backend=backend)
    result.update({"type": "complete", "elapsedSeconds": time.monotonic() - started, "message": "Model download complete"})
    emit(result, json_output)
    return result


def delete(model_name: str, json_output: bool, backend: str = "cpu") -> dict[str, Any]:
    settings = profile_settings(model_name)
    target, cache = managed_paths(settings, backend)
    candidates = [
        candidate
        for candidate in (target, cache)
        if candidate is not None and (candidate.exists() or is_link_or_junction(candidate))
    ]
    root = models_dir(settings)
    for candidate in candidates:
        validate_managed_path(root, candidate)

    removed_bytes = 0
    for candidate in candidates:
        removed_bytes += directory_size(candidate)
        remove_managed_path(root, candidate)
    result = status(model_name, backend=backend)
    result.update({"type": "deleted", "removedBytes": removed_bytes, "message": "Model download deleted"})
    emit(result, json_output)
    return result


def list_models(backend: str = "cpu") -> dict[str, Any]:
    return {
        "type": "models",
        "backend": backend,
        "models": [status(model_name, backend=backend) for model_name in AVAILABLE_MODELS],
        "message": "Model profiles listed",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Manage local faster-whisper model profiles.")
    parser.add_argument("action", choices=("status", "download", "delete", "list", "cleanup"))
    parser.add_argument("--model", default=None, help="faster-whisper model alias to manage")
    parser.add_argument("--json", action="store_true", help="Emit newline-delimited JSON events on stdout.")
    parser.add_argument("--include-remote", action="store_true", help="Fetch best-effort model size metadata for status.")
    parser.add_argument(
        "--backend",
        choices=("auto", "mlx", "cuda", "cpu"),
        default=None,
        help="Inference backend whose model format should be managed.",
    )
    args = parser.parse_args()
    model_name = args.model or get_settings().MODEL_NAME
    if args.action in {"status", "download", "delete"} and model_name not in AVAILABLE_MODELS:
        emit({"type": "error", "message": "Unsupported speech model profile."}, args.json)
        raise SystemExit(2)
    try:
        backend = resolved_backend(args.backend) if args.action != "cleanup" else "cpu"
        if args.action == "status":
            emit(
                status(model_name, include_remote=args.include_remote, backend=backend),
                args.json,
            )
        elif args.action == "download":
            download(model_name, args.json, backend)
        elif args.action == "delete":
            delete(model_name, args.json, backend)
        elif args.action == "list":
            emit(list_models(backend), args.json)
        else:
            emit(cleanup_incomplete_downloads(), args.json)
    except Exception as exc:
        emit({"type": "error", "message": str(exc)}, args.json)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
