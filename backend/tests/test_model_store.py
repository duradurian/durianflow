from pathlib import Path

import pytest

from app.config import Settings
from app.model_store import (
    ModelUnavailableError,
    expected_model_path,
    is_link_or_junction,
    model_cache_path,
    resolve_model_source,
)


def write_model_files(path: Path) -> None:
    path.mkdir()
    (path / "model.bin").write_bytes(b"fake")
    (path / "config.json").write_text("{}", encoding="utf-8")
    (path / "tokenizer.json").write_text("{}", encoding="utf-8")
    (path / "vocabulary.txt").write_text("token", encoding="utf-8")


def test_expected_model_path_uses_models_dir() -> None:
    settings = Settings(_env_file=None, MODELS_DIR="./models", MODEL_NAME="tiny")
    assert expected_model_path(settings).name == "tiny"


def test_resolve_model_source_uses_existing_model_path(tmp_path: Path) -> None:
    model_dir = tmp_path / "model"
    write_model_files(model_dir)
    source, local_only = resolve_model_source(Settings(_env_file=None, MODEL_PATH=str(model_dir)))
    assert source == str(model_dir.resolve())
    assert local_only is True


def test_resolve_model_source_rejects_incomplete_model_path(tmp_path: Path) -> None:
    model_dir = tmp_path / "model"
    model_dir.mkdir()
    with pytest.raises(ModelUnavailableError, match="not a complete"):
        resolve_model_source(Settings(_env_file=None, MODEL_PATH=str(model_dir)))


def test_resolve_model_source_rejects_zero_byte_required_file(tmp_path: Path) -> None:
    model_dir = tmp_path / "model"
    write_model_files(model_dir)
    (model_dir / "tokenizer.json").write_bytes(b"")

    with pytest.raises(ModelUnavailableError, match="not a complete"):
        resolve_model_source(Settings(_env_file=None, MODEL_PATH=str(model_dir)))


def test_resolve_model_source_rejects_missing_local_model(tmp_path: Path) -> None:
    settings = Settings(
        _env_file=None,
        MODELS_DIR=str(tmp_path),
        MODEL_NAME="missing",
        ALLOW_MODEL_DOWNLOAD=False,
    )
    with pytest.raises(ModelUnavailableError, match="Local Whisper model was not found"):
        resolve_model_source(settings)


def test_resolve_model_source_allows_explicit_download(tmp_path: Path) -> None:
    settings = Settings(_env_file=None, MODELS_DIR=str(tmp_path), MODEL_NAME="tiny", ALLOW_MODEL_DOWNLOAD=True)
    source, local_only = resolve_model_source(settings)
    assert source == "tiny"
    assert local_only is False


def test_resolve_model_source_allows_download_by_default(tmp_path: Path) -> None:
    settings = Settings(_env_file=None, MODELS_DIR=str(tmp_path), MODEL_NAME="tiny")
    source, local_only = resolve_model_source(settings)
    assert source == "tiny"
    assert local_only is False


def test_resolve_model_source_uses_complete_hugging_face_cache_when_offline(tmp_path: Path) -> None:
    settings = Settings(
        _env_file=None,
        MODELS_DIR=str(tmp_path),
        MODEL_NAME="tiny",
        ALLOW_MODEL_DOWNLOAD=False,
    )
    snapshot = model_cache_path(settings) / "snapshots" / "revision"
    snapshot.mkdir(parents=True)
    (snapshot / "model.bin").write_bytes(b"fake")
    (snapshot / "config.json").write_text("{}", encoding="utf-8")
    (snapshot / "tokenizer.json").write_text("{}", encoding="utf-8")
    (snapshot / "vocabulary.txt").write_text("token", encoding="utf-8")

    source, local_only = resolve_model_source(settings)

    assert source == str(snapshot.resolve())
    assert local_only is True


def test_windows_reparse_attribute_is_treated_as_link() -> None:
    class ReparsePath:
        def lstat(self):
            return type("Stat", (), {"st_file_attributes": 0x400})()

        def is_symlink(self):
            return False

    assert is_link_or_junction(ReparsePath()) is True
