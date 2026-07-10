from __future__ import annotations

import os
import shutil
import stat
from pathlib import Path

from app.config import BACKEND_ROOT, Settings


class ModelUnavailableError(RuntimeError):
    pass


REQUIRED_MODEL_FILES = ("model.bin", "config.json", "tokenizer.json")
VOCABULARY_FILES = ("vocabulary.json", "vocabulary.txt")
MODEL_FILE_REQUIREMENTS = (
    "model.bin, config.json, tokenizer.json, and vocabulary.json or vocabulary.txt"
)


def _resolve_path(value: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = BACKEND_ROOT / path
    # abspath normalizes dot segments without following a managed-slot symlink
    # or junction. Destructive callers must be able to inspect that boundary.
    return Path(os.path.abspath(path))


def is_link_or_junction(path: Path) -> bool:
    try:
        is_junction = getattr(path, "is_junction", None)
        attributes = getattr(path.lstat(), "st_file_attributes", 0)
        reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
        return (
            path.is_symlink()
            or bool(is_junction and is_junction())
            or bool(attributes & reparse_flag)
        )
    except FileNotFoundError:
        return False
    except OSError:
        return True


def remove_managed_path(root: Path, candidate: Path) -> None:
    """Remove one lexical child without following a symlink or junction."""
    root, candidate = validate_managed_path(root, candidate)
    if candidate.is_dir():
        shutil.rmtree(candidate)
    elif candidate.exists():
        candidate.unlink()


def validate_managed_path(root: Path, candidate: Path) -> tuple[Path, Path]:
    """Validate a direct managed child without mutating the filesystem."""
    root = Path(os.path.abspath(root))
    candidate = Path(os.path.abspath(candidate))
    forbidden_roots = {Path(root.anchor), Path.home(), BACKEND_ROOT}
    if root in forbidden_roots:
        raise RuntimeError(f"Refusing to use a broad directory for destructive model operations: {root}")
    if is_link_or_junction(root):
        raise RuntimeError(f"Refusing to manage models through a linked directory: {root}")
    try:
        relative = candidate.relative_to(root)
    except ValueError as exc:
        raise RuntimeError(f"Refusing to remove path outside model directory: {candidate}") from exc
    if len(relative.parts) != 1 or candidate.parent != root:
        raise RuntimeError("Refusing to remove anything except a direct model-directory child")
    if is_link_or_junction(candidate):
        raise RuntimeError(f"Refusing to remove linked model path: {candidate}")
    return root, candidate


def model_dir_name(model_name: str) -> str:
    # Hugging Face repository IDs use forward slashes, but reject Windows path
    # separators too so a configured ID can never escape MODELS_DIR.
    name = model_name.strip().replace("/", "__").replace("\\", "__")
    if not name or name in {".", ".."}:
        raise ValueError("MODEL_NAME must identify a model")
    return name


def is_valid_model_dir(path: Path) -> bool:
    def nonempty_file(name: str) -> bool:
        candidate = path / name
        try:
            return candidate.is_file() and candidate.stat().st_size > 0
        except OSError:
            return False

    return (
        path.is_dir()
        and all(nonempty_file(name) for name in REQUIRED_MODEL_FILES)
        and any(nonempty_file(name) for name in VOCABULARY_FILES)
    )


def expected_model_path(settings: Settings) -> Path:
    if settings.MODEL_PATH:
        return _resolve_path(settings.MODEL_PATH)
    return _resolve_path(str(_resolve_path(settings.MODELS_DIR) / model_dir_name(settings.MODEL_NAME)))


def model_repository(model_name: str) -> str:
    """Resolve faster-whisper aliases to their Hugging Face repository ID."""
    try:
        from faster_whisper.utils import _MODELS  # type: ignore[attr-defined]

        return str(_MODELS.get(model_name, model_name))
    except (ImportError, AttributeError):
        return model_name


def model_cache_path(settings: Settings) -> Path:
    repository = model_repository(settings.MODEL_NAME).replace("/", "--").replace("\\", "--")
    return _resolve_path(str(_resolve_path(settings.MODELS_DIR) / f"models--{repository}"))


def cached_model_snapshot(path: Path) -> Path | None:
    """Return the newest complete Hugging Face cache snapshot, if one exists."""
    snapshots = path / "snapshots"
    try:
        candidates = [candidate for candidate in snapshots.iterdir() if candidate.is_dir()]
    except OSError:
        return None

    valid = [candidate for candidate in candidates if is_valid_model_dir(candidate)]
    if not valid:
        return None

    def modified_at(candidate: Path) -> float:
        try:
            return candidate.stat().st_mtime
        except OSError:
            return 0.0

    return max(valid, key=lambda candidate: (modified_at(candidate), candidate.name))


def resolve_model_source(settings: Settings) -> tuple[str, bool]:
    """Return the model source and whether faster-whisper may use network access."""
    if settings.MODEL_PATH:
        path = _resolve_path(settings.MODEL_PATH)
        if is_valid_model_dir(path):
            return str(path), True
        if path.exists():
            raise ModelUnavailableError(
                f"Configured MODEL_PATH exists but is not a complete faster-whisper model: {path}. "
                f"Expected {MODEL_FILE_REQUIREMENTS}."
            )
        raise ModelUnavailableError(
            f"Configured MODEL_PATH does not exist: {path}. "
            "Run backend/scripts/install_model.py or update MODEL_PATH."
        )

    path = expected_model_path(settings)
    if is_valid_model_dir(path):
        return str(path), True

    cached = cached_model_snapshot(model_cache_path(settings))
    if cached is not None:
        return str(cached), True

    if path.exists():
        raise ModelUnavailableError(
            f"Local Whisper model directory is incomplete at {path}. "
            f"Expected {MODEL_FILE_REQUIREMENTS}. Re-run install_model.py with --force."
        )

    if settings.ALLOW_MODEL_DOWNLOAD:
        return settings.MODEL_NAME, False

    raise ModelUnavailableError(
        f"Local Whisper model was not found at {path}. "
        f"Run `python scripts/install_model.py {settings.MODEL_NAME}` from backend/, "
        "set MODEL_PATH to an existing faster-whisper model directory, "
        "or set ALLOW_MODEL_DOWNLOAD=true to let faster-whisper download/cache it at startup."
    )
