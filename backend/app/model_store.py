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
MLX_WEIGHT_FILES = ("weights.safetensors", "weights.npz")
MLX_MODEL_FILE_REQUIREMENTS = "config.json and weights.safetensors or weights.npz"
MLX_MODEL_REPOSITORIES = {
    "tiny": "mlx-community/whisper-tiny-mlx",
    "base": "mlx-community/whisper-base-mlx",
    "small": "mlx-community/whisper-small-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
    "distil-large-v3": "mlx-community/distil-whisper-large-v3",
}


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


def validate_managed_root(root: Path) -> Path:
    """Validate a lexical model root without following linked ancestors."""
    root = Path(os.path.abspath(root))
    forbidden_roots = {Path(root.anchor), Path.home(), BACKEND_ROOT}
    if root in forbidden_roots:
        raise RuntimeError(f"Refusing to use a broad directory for destructive model operations: {root}")
    for component in (root, *root.parents):
        if component == Path(component.anchor):
            continue
        if is_link_or_junction(component):
            raise RuntimeError(
                f"Refusing to manage models through a linked directory component: {component}"
            )
    return root


def validate_managed_path(root: Path, candidate: Path) -> tuple[Path, Path]:
    """Validate a direct managed child without mutating the filesystem."""
    root = validate_managed_root(root)
    candidate = Path(os.path.abspath(candidate))
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


def is_valid_mlx_model_dir(path: Path) -> bool:
    def nonempty_file(name: str) -> bool:
        candidate = path / name
        try:
            return candidate.is_file() and candidate.stat().st_size > 0
        except OSError:
            return False

    return (
        path.is_dir()
        and nonempty_file("config.json")
        and any(nonempty_file(name) for name in MLX_WEIGHT_FILES)
    )


def expected_model_path(settings: Settings) -> Path:
    if settings.MODEL_PATH:
        return _resolve_path(settings.MODEL_PATH)
    return _resolve_path(str(_resolve_path(settings.MODELS_DIR) / model_dir_name(settings.MODEL_NAME)))


def expected_mlx_model_path(settings: Settings) -> Path:
    if settings.MLX_MODEL_PATH:
        return _resolve_path(settings.MLX_MODEL_PATH)
    name = model_dir_name(settings.MODEL_NAME)
    return _resolve_path(str(_resolve_path(settings.MODELS_DIR) / f"mlx--{name}"))


def model_repository(model_name: str) -> str:
    """Resolve faster-whisper aliases to their Hugging Face repository ID."""
    try:
        from faster_whisper.utils import _MODELS  # type: ignore[attr-defined]

        return str(_MODELS.get(model_name, model_name))
    except (ImportError, AttributeError):
        return model_name


def mlx_model_repository(model_name: str) -> str:
    try:
        return MLX_MODEL_REPOSITORIES[model_name]
    except KeyError as exc:
        supported = ", ".join(sorted(MLX_MODEL_REPOSITORIES))
        raise ModelUnavailableError(
            f"No verified MLX Whisper checkpoint is configured for {model_name!r}. "
            f"Choose one of: {supported}."
        ) from exc


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


def resolve_mlx_model_source(settings: Settings) -> tuple[str, bool]:
    """Return an MLX model source and whether it is already local."""
    if settings.MLX_MODEL_PATH:
        path = _resolve_path(settings.MLX_MODEL_PATH)
        if is_valid_mlx_model_dir(path):
            return str(path), True
        if path.exists():
            raise ModelUnavailableError(
                f"Configured MLX_MODEL_PATH exists but is not a complete MLX Whisper model: "
                f"{path}. Expected {MLX_MODEL_FILE_REQUIREMENTS}."
            )
        raise ModelUnavailableError(
            f"Configured MLX_MODEL_PATH does not exist: {path}. "
            "Run backend/scripts/install_model.py --backend mlx or update MLX_MODEL_PATH."
        )

    path = expected_mlx_model_path(settings)
    if is_valid_mlx_model_dir(path):
        return str(path), True
    if path.exists():
        if settings.ALLOW_MODEL_DOWNLOAD:
            return mlx_model_repository(settings.MODEL_NAME), False
        raise ModelUnavailableError(
            f"Local MLX Whisper model directory is incomplete at {path}. "
            f"Expected {MLX_MODEL_FILE_REQUIREMENTS}. Re-run install_model.py with --force."
        )
    if settings.ALLOW_MODEL_DOWNLOAD:
        return mlx_model_repository(settings.MODEL_NAME), False
    raise ModelUnavailableError(
        f"Local MLX Whisper model was not found at {path}. "
        f"Run `python scripts/install_model.py {settings.MODEL_NAME} --backend mlx` from backend/, "
        "set MLX_MODEL_PATH to an existing MLX Whisper model directory, "
        "or set ALLOW_MODEL_DOWNLOAD=true."
    )


def ensure_mlx_model(settings: Settings) -> str:
    """Resolve or atomically download the selected MLX model into MODELS_DIR."""
    source, local_only = resolve_mlx_model_source(settings)
    if local_only:
        return source

    try:
        from huggingface_hub import snapshot_download
    except ImportError as exc:
        raise ModelUnavailableError(
            "huggingface-hub is required to download MLX Whisper models."
        ) from exc

    target = expected_mlx_model_path(settings)
    root = _resolve_path(settings.MODELS_DIR)
    temporary = root / f".{target.name}.download"
    validate_managed_path(root, target)
    validate_managed_path(root, temporary)
    root.mkdir(parents=True, exist_ok=True)
    if temporary.exists() or is_link_or_junction(temporary):
        remove_managed_path(root, temporary)
    if target.exists() or is_link_or_junction(target):
        remove_managed_path(root, target)
    temporary.mkdir()
    try:
        snapshot_download(repo_id=source, local_dir=str(temporary))
        if not is_valid_mlx_model_dir(temporary):
            raise ModelUnavailableError(
                f"Downloaded MLX model at {temporary} is incomplete. "
                f"Expected {MLX_MODEL_FILE_REQUIREMENTS}."
            )
        temporary.replace(target)
    except Exception:
        if temporary.exists() or is_link_or_junction(temporary):
            remove_managed_path(root, temporary)
        raise
    return str(target)
