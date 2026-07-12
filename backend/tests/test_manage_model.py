from pathlib import Path

import pytest

from app.config import Settings

from scripts import manage_model


def write_model(path: Path) -> None:
    path.mkdir(parents=True)
    (path / "model.bin").write_bytes(b"model")
    (path / "config.json").write_text("{}", encoding="utf-8")
    (path / "tokenizer.json").write_text("{}", encoding="utf-8")
    (path / "vocabulary.json").write_text("{}", encoding="utf-8")


def test_cleanup_removes_only_incomplete_managed_downloads(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(manage_model, "models_dir", lambda _settings: tmp_path)

    incomplete_direct = tmp_path / "small"
    incomplete_direct.mkdir()
    (incomplete_direct / "partial.bin").write_bytes(b"partial")

    incomplete_cache = tmp_path / "models--Systran--faster-whisper-medium"
    incomplete_cache.mkdir()
    (incomplete_cache / "partial.bin").write_bytes(b"partial")

    temporary = tmp_path / ".large-v3-turbo.download"
    temporary.mkdir()

    complete = tmp_path / "base"
    write_model(complete)
    unrelated = tmp_path / "unrelated"
    unrelated.mkdir()
    locks = tmp_path / ".locks"
    locks.mkdir()

    result = manage_model.cleanup_incomplete_downloads()

    assert not incomplete_direct.exists()
    assert not incomplete_cache.exists()
    assert not temporary.exists()
    assert complete.exists()
    assert unrelated.exists()
    assert locks.exists()
    assert len(result["removed"]) == 3


def test_delete_refuses_linked_model_slot(monkeypatch, tmp_path: Path) -> None:
    root = tmp_path / "models"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    marker = outside / "keep.txt"
    marker.write_text("keep", encoding="utf-8")
    slot = root / "small"
    try:
        slot.symlink_to(outside, target_is_directory=True)
    except OSError as exc:
        pytest.skip(f"Directory symlinks are unavailable: {exc}")

    monkeypatch.setattr(
        manage_model,
        "profile_settings",
        lambda model_name: Settings(
            _env_file=None,
            MODEL_NAME=model_name,
            MODELS_DIR=str(root),
            MODEL_PATH=None,
        ),
    )

    with pytest.raises(RuntimeError, match="linked model path"):
        manage_model.delete("small", json_output=True)

    assert marker.read_text(encoding="utf-8") == "keep"
    assert slot.is_symlink()


def test_cleanup_refuses_linked_models_root(monkeypatch, tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    marker = outside / "keep.txt"
    marker.write_text("keep", encoding="utf-8")
    root = tmp_path / "models"
    try:
        root.symlink_to(outside, target_is_directory=True)
    except OSError as exc:
        pytest.skip(f"Directory symlinks are unavailable: {exc}")

    monkeypatch.setattr(manage_model, "models_dir", lambda _settings: root)

    with pytest.raises(RuntimeError, match="linked directory"):
        manage_model.cleanup_incomplete_downloads()

    assert marker.read_text(encoding="utf-8") == "keep"
    assert root.is_symlink()


def test_relative_linked_models_root_is_not_resolved_before_cleanup(monkeypatch, tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    incomplete = outside / "small"
    incomplete.mkdir()
    (incomplete / "keep.txt").write_text("keep", encoding="utf-8")
    root = tmp_path / "models"
    try:
        root.symlink_to(outside, target_is_directory=True)
    except OSError as exc:
        pytest.skip(f"Directory symlinks are unavailable: {exc}")

    monkeypatch.setattr(manage_model, "ROOT", tmp_path)
    monkeypatch.setattr(
        manage_model,
        "get_settings",
        lambda: Settings(_env_file=None, MODELS_DIR="./models"),
    )

    with pytest.raises(RuntimeError, match="linked directory"):
        manage_model.cleanup_incomplete_downloads()

    assert (incomplete / "keep.txt").read_text(encoding="utf-8") == "keep"


def test_cleanup_refuses_linked_models_root_ancestor(monkeypatch, tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    models = outside / "models"
    incomplete = models / "small"
    incomplete.mkdir(parents=True)
    marker = incomplete / "keep.txt"
    marker.write_text("keep", encoding="utf-8")
    linked_parent = tmp_path / "linked-parent"
    try:
        linked_parent.symlink_to(outside, target_is_directory=True)
    except OSError as exc:
        pytest.skip(f"Directory symlinks are unavailable: {exc}")

    monkeypatch.setattr(
        manage_model,
        "get_settings",
        lambda: Settings(
            _env_file=None,
            MODELS_DIR=str(linked_parent / "models"),
        ),
    )

    with pytest.raises(RuntimeError, match="linked directory component"):
        manage_model.cleanup_incomplete_downloads()

    assert marker.read_text(encoding="utf-8") == "keep"
