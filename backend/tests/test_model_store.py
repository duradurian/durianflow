import hashlib
import json
from pathlib import Path

import pytest

import app.model_store as model_store
from app.config import Settings
from app.model_manifest import OfficialModelSpec
from app.model_store import ModelUnavailableError, expected_model_path, resolve_model_source


def make_test_spec() -> OfficialModelSpec:
    files = {
        "model.bin": b"model",
        "config.json": b"{}",
        "tokenizer.json": b"tokenizer",
        "vocabulary.json": b"vocabulary",
        "preprocessor_config.json": b"{}",
    }
    return OfficialModelSpec(
        model_id="tiny",
        repository_id="example/tiny",
        revision="0123456789abcdef0123456789abcdef01234567",
        files={name: hashlib.sha256(contents).hexdigest() for name, contents in files.items()},
    )


def install_official_model(path: Path, spec: OfficialModelSpec) -> None:
    path.mkdir()
    contents = {
        "model.bin": b"model",
        "config.json": b"{}",
        "tokenizer.json": b"tokenizer",
        "vocabulary.json": b"vocabulary",
        "preprocessor_config.json": b"{}",
    }
    for name in spec.files:
        (path / name).write_bytes(contents[name])


@pytest.fixture
def official(monkeypatch):
    spec = make_test_spec()

    def lookup(model_id: str) -> OfficialModelSpec:
        if model_id != spec.model_id:
            raise ValueError("not approved")
        return spec

    monkeypatch.setattr(model_store, "get_official_model_spec", lookup)
    return spec


def test_expected_model_path_uses_models_dir(official: OfficialModelSpec) -> None:
    settings = Settings(_env_file=None, MODELS_DIR="./models", MODEL_NAME="tiny")
    assert expected_model_path(settings).name == "tiny"


def test_resolve_model_source_uses_verified_managed_model(tmp_path: Path, official: OfficialModelSpec) -> None:
    model_dir = tmp_path / "tiny"
    install_official_model(model_dir, official)
    source, local_only = resolve_model_source(Settings(_env_file=None, MODELS_DIR=str(tmp_path), MODEL_NAME="tiny"))
    assert source == str(model_dir.resolve())
    assert local_only is True


def test_resolve_model_source_rejects_model_path_override(tmp_path: Path, official: OfficialModelSpec) -> None:
    with pytest.raises(ModelUnavailableError, match="MODEL_PATH overrides"):
        resolve_model_source(Settings(_env_file=None, MODELS_DIR=str(tmp_path), MODEL_NAME="tiny", MODEL_PATH="other"))


def test_resolve_model_source_rejects_unknown_or_missing_model(tmp_path: Path, official: OfficialModelSpec) -> None:
    with pytest.raises(ModelUnavailableError, match="not approved"):
        resolve_model_source(Settings(_env_file=None, MODELS_DIR=str(tmp_path), MODEL_NAME="missing"))
    with pytest.raises(ModelUnavailableError, match="not found"):
        resolve_model_source(Settings(_env_file=None, MODELS_DIR=str(tmp_path), MODEL_NAME="tiny"))


def test_runtime_download_remains_disabled_even_if_legacy_flag_is_set(tmp_path: Path, official: OfficialModelSpec) -> None:
    with pytest.raises(ModelUnavailableError, match="runtime download is disabled"):
        resolve_model_source(Settings(_env_file=None, MODELS_DIR=str(tmp_path), MODEL_NAME="tiny", ALLOW_MODEL_DOWNLOAD=True))


def test_model_integrity_mismatch_is_rejected(tmp_path: Path, official: OfficialModelSpec) -> None:
    model_dir = tmp_path / "tiny"
    install_official_model(model_dir, official)
    (model_dir / "model.bin").write_bytes(b"tampered")
    with pytest.raises(ModelUnavailableError, match="integrity"):
        resolve_model_source(Settings(_env_file=None, MODELS_DIR=str(tmp_path), MODEL_NAME="tiny"))


def test_custom_model_is_selected_only_by_strict_config_file(tmp_path: Path, official: OfficialModelSpec) -> None:
    custom_root = tmp_path / "custom-models"
    custom_root.mkdir()
    custom_model = custom_root / "my-local-model"
    custom_model.mkdir()
    for name in ("model.bin", "config.json", "tokenizer.json", "vocabulary.json"):
        (custom_model / name).write_text("fixture", encoding="utf-8")
    config = custom_root / "custom-model.json"
    config.write_text(json.dumps({"version": 1, "enabled": True, "modelId": "my-local-model"}), encoding="utf-8")
    source, local_only = resolve_model_source(
        Settings(
            _env_file=None,
            MODELS_DIR=str(tmp_path / "official"),
            MODEL_NAME="tiny",
            CUSTOM_MODELS_DIR=str(custom_root),
            CUSTOM_MODEL_CONFIG_PATH=str(config),
        )
    )
    assert source == str(custom_model.resolve())
    assert local_only is True


def test_custom_model_config_rejects_path_escape(tmp_path: Path, official: OfficialModelSpec) -> None:
    root = tmp_path / "custom"
    root.mkdir()
    config = root / "custom-model.json"
    config.write_text(json.dumps({"version": 1, "enabled": True, "modelId": "../outside"}), encoding="utf-8")
    with pytest.raises(ModelUnavailableError, match="Custom model ID"):
        resolve_model_source(
            Settings(_env_file=None, MODEL_NAME="tiny", CUSTOM_MODELS_DIR=str(root), CUSTOM_MODEL_CONFIG_PATH=str(config))
        )


def test_custom_model_config_must_be_inside_custom_root(tmp_path: Path, official: OfficialModelSpec) -> None:
    root = tmp_path / "custom"
    root.mkdir()
    config = tmp_path / "custom-model.json"
    config.write_text(json.dumps({"version": 1, "enabled": False, "modelId": "unused"}), encoding="utf-8")
    with pytest.raises(ModelUnavailableError, match="inside the custom model root"):
        resolve_model_source(
            Settings(_env_file=None, MODEL_NAME="tiny", CUSTOM_MODELS_DIR=str(root), CUSTOM_MODEL_CONFIG_PATH=str(config))
        )


def test_model_store_rejects_unc_root(official: OfficialModelSpec) -> None:
    with pytest.raises(ModelUnavailableError, match="UNC"):
        expected_model_path(Settings(_env_file=None, MODELS_DIR=r"\\server\share", MODEL_NAME="tiny"))


def test_model_store_rejects_symlinked_model(tmp_path: Path, official: OfficialModelSpec) -> None:
    outside = tmp_path / "outside"
    install_official_model(outside, official)
    target = tmp_path / "tiny"
    try:
        target.symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("Creating a directory symlink is not permitted in this environment")
    with pytest.raises(ModelUnavailableError, match="integrity|unsafe"):
        resolve_model_source(Settings(_env_file=None, MODELS_DIR=str(tmp_path), MODEL_NAME="tiny"))
