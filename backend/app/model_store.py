"""Model-source policy and filesystem checks for the local worker."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
from dataclasses import dataclass
from pathlib import Path

from app.config import BACKEND_ROOT, Settings
from app.model_manifest import OfficialModelSpec, get_official_model_spec


class ModelUnavailableError(RuntimeError):
    """A requested model does not satisfy the local model policy."""


MAX_CUSTOM_CONFIG_BYTES = 8 * 1024
CUSTOM_MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")


@dataclass(frozen=True)
class CustomModelSelection:
    model_id: str
    path: Path


def _resolve_path(value: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = BACKEND_ROOT / path
    # Do not resolve here: resolving before checking components can silently
    # follow a junction/symlink supplied by another local process.
    return Path(os.path.abspath(path))


def _is_unc_path(path: Path) -> bool:
    text = str(path)
    return text.startswith(("\\\\", "//"))


def _is_reparse_point(path: Path) -> bool:
    try:
        info = path.lstat()
    except OSError:
        return False
    attributes = getattr(info, "st_file_attributes", 0)
    reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return stat.S_ISLNK(info.st_mode) or bool(attributes & reparse)


def _assert_safe_existing_ancestors(path: Path) -> None:
    """Reject UNC and all existing symlink/reparse components of ``path``."""
    if _is_unc_path(path):
        raise ModelUnavailableError("UNC model paths are not permitted.")
    absolute = Path(os.path.abspath(path))
    chain = [absolute, *absolute.parents]
    for candidate in reversed(chain):
        if candidate.exists() or candidate.is_symlink():
            if _is_reparse_point(candidate):
                raise ModelUnavailableError("Model paths may not contain symbolic links or reparse points.")


def _safe_child(root: Path, name: str) -> Path:
    _assert_safe_existing_ancestors(root)
    target = root / name
    _assert_safe_existing_ancestors(target)
    try:
        target.resolve(strict=False).relative_to(root.resolve(strict=False))
    except ValueError as exc:
        raise ModelUnavailableError("Model path escapes its managed root.") from exc
    return target.resolve(strict=False)


def _assert_safe_model_tree(path: Path) -> None:
    _assert_safe_existing_ancestors(path)
    if not path.is_dir():
        return
    for current, directories, files in os.walk(path, followlinks=False):
        current_path = Path(current)
        for name in [*directories, *files]:
            candidate = current_path / name
            if _is_reparse_point(candidate):
                raise ModelUnavailableError("Model trees may not contain symbolic links or reparse points.")


def models_root(settings: Settings) -> Path:
    """Return the managed root for release-pinned official artifacts."""
    root = _resolve_path(settings.MODELS_DIR)
    _assert_safe_existing_ancestors(root)
    return root


def custom_models_root(settings: Settings) -> Path:
    root = _resolve_path(settings.CUSTOM_MODELS_DIR)
    _assert_safe_existing_ancestors(root)
    return root


def model_dir_name(model_name: str) -> str:
    """Official IDs are manifest-owned and may not become filesystem paths."""
    return get_official_model_spec(model_name).model_id


def official_model_path(settings: Settings, model_name: str | None = None) -> Path:
    if settings.MODEL_PATH:
        raise ModelUnavailableError("MODEL_PATH overrides are disabled; use the managed model store.")
    spec = get_official_model_spec(model_name or settings.MODEL_NAME)
    return _safe_child(models_root(settings), spec.model_id)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_valid_official_model_dir(path: Path, spec: OfficialModelSpec) -> bool:
    """Verify the release-pinned file set without trusting local manifests."""
    try:
        _assert_safe_model_tree(path)
        if not path.is_dir():
            return False
        for name, expected_hash in spec.files.items():
            candidate = path / name
            if _is_reparse_point(candidate) or not candidate.is_file():
                return False
            if _sha256(candidate) != expected_hash:
                return False
    except (ModelUnavailableError, OSError):
        return False
    return True


def is_valid_custom_model_dir(path: Path) -> bool:
    """Custom models are user-managed but still require a safe CTranslate2 layout."""
    required = ("model.bin", "config.json", "tokenizer.json", "vocabulary.json")
    try:
        _assert_safe_model_tree(path)
        return path.is_dir() and all((path / name).is_file() and not _is_reparse_point(path / name) for name in required)
    except (ModelUnavailableError, OSError):
        return False


def _custom_model_config_path(settings: Settings) -> Path | None:
    if not settings.CUSTOM_MODEL_CONFIG_PATH:
        return None
    path = _resolve_path(settings.CUSTOM_MODEL_CONFIG_PATH)
    _assert_safe_existing_ancestors(path)
    root = custom_models_root(settings)
    try:
        path.resolve(strict=False).relative_to(root.resolve(strict=False))
    except ValueError as exc:
        raise ModelUnavailableError("Custom model configuration must be inside the custom model root.") from exc
    return path


def load_custom_model_selection(settings: Settings) -> CustomModelSelection | None:
    """Read the small, strict opt-in custom-model selection file.

    The file can only name a directory below ``CUSTOM_MODELS_DIR``.  It cannot
    select a repository, a network URL, an absolute path, or custom hashes.
    """
    config_path = _custom_model_config_path(settings)
    if config_path is None:
        return None
    if not config_path.is_file() or _is_reparse_point(config_path):
        raise ModelUnavailableError("Custom model configuration file is unavailable.")
    try:
        raw = config_path.read_bytes()
        if len(raw) > MAX_CUSTOM_CONFIG_BYTES:
            raise ModelUnavailableError("Custom model configuration is too large.")
        payload = json.loads(raw.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ModelUnavailableError("Custom model configuration is invalid.") from exc
    if not isinstance(payload, dict) or set(payload) != {"version", "enabled", "modelId"}:
        raise ModelUnavailableError("Custom model configuration has an invalid shape.")
    if payload["version"] != 1 or not isinstance(payload["enabled"], bool):
        raise ModelUnavailableError("Custom model configuration has an invalid version or enabled flag.")
    if not payload["enabled"]:
        return None
    model_id = payload["modelId"]
    if not isinstance(model_id, str) or not CUSTOM_MODEL_ID.fullmatch(model_id):
        raise ModelUnavailableError("Custom model ID is invalid.")
    return CustomModelSelection(model_id=model_id, path=_safe_child(custom_models_root(settings), model_id))


def expected_model_path(settings: Settings) -> Path:
    custom = load_custom_model_selection(settings)
    return custom.path if custom else official_model_path(settings)


def resolve_model_source(settings: Settings) -> tuple[str, bool]:
    """Resolve only a verified local model; runtime download is never permitted."""
    custom = load_custom_model_selection(settings)
    if custom:
        if is_valid_custom_model_dir(custom.path):
            return str(custom.path), True
        raise ModelUnavailableError("Configured custom model is incomplete or unsafe.")

    if settings.MODEL_PATH:
        raise ModelUnavailableError("MODEL_PATH overrides are disabled; use the managed model store.")
    try:
        spec = get_official_model_spec(settings.MODEL_NAME)
    except ValueError as exc:
        raise ModelUnavailableError("Configured model is not approved for this release.") from exc
    path = official_model_path(settings, spec.model_id)
    if is_valid_official_model_dir(path, spec):
        return str(path), True
    if path.exists():
        raise ModelUnavailableError("Local official model failed integrity verification. Reinstall it from the release.")
    raise ModelUnavailableError(
        "Local official model was not found. Install the release-approved model; runtime download is disabled."
    )


def remove_managed_model_tree(path: Path, root: Path) -> None:
    """Remove a known managed target without traversing junctions/reparse points."""
    safe_path = _safe_child(root, path.name)
    if safe_path != path.resolve(strict=False):
        raise ModelUnavailableError("Refusing to delete outside the managed model root.")
    if path.exists() or path.is_symlink():
        _assert_safe_model_tree(path)
        shutil.rmtree(path)
