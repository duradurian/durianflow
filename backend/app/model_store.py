from __future__ import annotations

from pathlib import Path

from app.config import BACKEND_ROOT, Settings


class ModelUnavailableError(RuntimeError):
    pass


REQUIRED_MODEL_FILES = ("model.bin", "config.json")


def _resolve_path(value: str) -> Path:
    path = Path(value).expanduser()
    if path.is_absolute():
        return path
    return (BACKEND_ROOT / path).resolve()


def model_dir_name(model_name: str) -> str:
    return model_name.replace("/", "__")


def is_valid_model_dir(path: Path) -> bool:
    return path.is_dir() and all((path / name).is_file() for name in REQUIRED_MODEL_FILES)


def expected_model_path(settings: Settings) -> Path:
    if settings.MODEL_PATH:
        return _resolve_path(settings.MODEL_PATH)
    return (_resolve_path(settings.MODELS_DIR) / model_dir_name(settings.MODEL_NAME)).resolve()


def resolve_model_source(settings: Settings) -> tuple[str, bool]:
    """Return the model source and whether faster-whisper may use network access."""
    if settings.MODEL_PATH:
        path = _resolve_path(settings.MODEL_PATH)
        if is_valid_model_dir(path):
            return str(path), True
        if path.exists():
            raise ModelUnavailableError(
                f"Configured MODEL_PATH exists but is not a complete faster-whisper model: {path}. "
                "Expected model.bin and config.json."
            )
        raise ModelUnavailableError(
            f"Configured MODEL_PATH does not exist: {path}. "
            "Run backend/scripts/install_model.py or update MODEL_PATH."
        )

    path = expected_model_path(settings)
    if is_valid_model_dir(path):
        return str(path), True
    if path.exists():
        raise ModelUnavailableError(
            f"Local Whisper model directory is incomplete at {path}. "
            "Expected model.bin and config.json. Re-run install_model.py with --force."
        )

    if settings.ALLOW_MODEL_DOWNLOAD:
        return settings.MODEL_NAME, False

    raise ModelUnavailableError(
        f"Local Whisper model was not found at {path}. "
        f"Run `python scripts/install_model.py {settings.MODEL_NAME}` from backend/, "
        "set MODEL_PATH to an existing faster-whisper model directory, "
        "or set ALLOW_MODEL_DOWNLOAD=true to let faster-whisper download/cache it at startup."
    )
