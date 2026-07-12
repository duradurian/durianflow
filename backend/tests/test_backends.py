import types

import pytest

from app.backends import (
    BackendCapability,
    BackendUnavailableError,
    detect_backend_capabilities,
    select_backend,
    without_disabled_backends,
)


def test_apple_silicon_prefers_mlx_then_cpu() -> None:
    modules = {"mlx_whisper", "mlx.core", "faster_whisper"}

    def importer(name: str):
        if name in {"mlx_whisper", "faster_whisper"}:
            return types.SimpleNamespace()
        if name == "mlx.core":
            return types.SimpleNamespace(metal=types.SimpleNamespace(is_available=lambda: True))
        if name == "ctranslate2":
            return types.SimpleNamespace(get_cuda_device_count=lambda: 0)
        raise AssertionError(name)

    capabilities = detect_backend_capabilities(
        system="Darwin",
        machine="arm64",
        module_available=lambda name: name in modules,
        importer=importer,
        mlx_probe=lambda: (True, None),
    )

    assert select_backend("auto", capabilities) == "mlx"
    assert [item.name for item in capabilities if item.available] == ["mlx", "cpu"]


def test_cuda_is_selected_when_mlx_is_not_supported() -> None:
    capabilities = detect_backend_capabilities(
        system="Windows",
        machine="AMD64",
        module_available=lambda name: name == "faster_whisper",
        importer=lambda name: types.SimpleNamespace(get_cuda_device_count=lambda: 1),
    )

    assert select_backend("auto", capabilities) == "cuda"


def test_explicit_unavailable_backend_has_actionable_error() -> None:
    capabilities = detect_backend_capabilities(
        system="Linux",
        machine="x86_64",
        module_available=lambda _name: False,
    )

    with pytest.raises(BackendUnavailableError, match="Requested MLX backend is unavailable"):
        select_backend("mlx", capabilities)
    with pytest.raises(BackendUnavailableError, match="No transcription backend"):
        select_backend("auto", capabilities)


def test_broken_runtime_import_does_not_report_cpu_or_cuda_available() -> None:
    def importer(name: str):
        if name == "faster_whisper":
            raise OSError("native library failed to load")
        raise AssertionError(name)

    capabilities = detect_backend_capabilities(
        system="Linux",
        machine="x86_64",
        module_available=lambda name: name == "faster_whisper",
        importer=importer,
    )

    by_name = {item.name: item for item in capabilities}
    assert by_name["cuda"].available is False
    assert by_name["cpu"].available is False
    assert "native library failed to load" in (by_name["cpu"].reason or "")


def test_windows_registers_dll_directories_before_native_import(monkeypatch) -> None:
    order = []

    monkeypatch.setattr(
        "app.backends.configure_cuda_dll_paths",
        lambda: order.append("configure"),
    )

    def importer(name: str):
        order.append(name)
        if name == "ctranslate2":
            return types.SimpleNamespace(get_cuda_device_count=lambda: 1)
        return types.SimpleNamespace()

    capabilities = detect_backend_capabilities(
        system="Windows",
        machine="AMD64",
        module_available=lambda name: name == "faster_whisper",
        importer=importer,
    )

    assert order[:3] == ["configure", "faster_whisper", "ctranslate2"]
    assert select_backend("auto", capabilities) == "cuda"


def test_mlx_native_abort_is_reported_as_unavailable() -> None:
    def runner(*_args, **_kwargs):
        return types.SimpleNamespace(
            returncode=-6,
            stdout="",
            stderr="libc++abi: terminating with uncaught Metal exception\n",
        )

    from app.backends import _probe_mlx_runtime

    available, reason = _probe_mlx_runtime(runner=runner)

    assert available is False
    assert "exit -6" in (reason or "")
    assert "Metal exception" in (reason or "")


def test_disabled_native_backend_is_removed_from_automatic_selection() -> None:
    detected = (
        BackendCapability("mlx", True, "metal", "float16"),
        BackendCapability("cuda", True, "cuda", "float16"),
        BackendCapability("cpu", True, "cpu", "int8"),
    )
    filtered = without_disabled_backends(detected, {"mlx", "cuda"})

    assert select_backend("auto", filtered) == "cpu"
    assert [item.name for item in filtered if item.available] == ["cpu"]
    assert "native backend failure" in (filtered[0].reason or "")
