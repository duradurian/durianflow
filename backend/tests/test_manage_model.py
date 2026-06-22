from pathlib import Path

from scripts import manage_model


def write_model(path: Path) -> None:
    path.mkdir(parents=True)
    (path / "model.bin").write_bytes(b"model")
    (path / "config.json").write_text("{}", encoding="utf-8")


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
    locks = tmp_path / ".locks"
    locks.mkdir()

    result = manage_model.cleanup_incomplete_downloads()

    assert not incomplete_direct.exists()
    assert not incomplete_cache.exists()
    assert not temporary.exists()
    assert complete.exists()
    assert locks.exists()
    assert len(result["removed"]) == 3
