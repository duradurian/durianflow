from app import cuda_runtime


def test_cuda_dll_directory_handles_are_retained_and_paths_are_deduplicated(
    monkeypatch,
    tmp_path,
) -> None:
    first = tmp_path / "cublas"
    second = tmp_path / "cudnn"
    first.mkdir()
    second.mkdir()
    handles = []

    class Handle:
        pass

    def add_dll_directory(path: str) -> Handle:
        handle = Handle()
        handles.append((path, handle))
        return handle

    monkeypatch.setattr(cuda_runtime.platform, "system", lambda: "Windows")
    monkeypatch.setattr(cuda_runtime, "_candidate_cuda_bin_dirs", lambda: [first, second, first])
    monkeypatch.setattr(cuda_runtime.os, "add_dll_directory", add_dll_directory, raising=False)
    monkeypatch.setenv("PATH", "existing")
    monkeypatch.setattr(cuda_runtime, "_DLL_DIRECTORY_HANDLES", {})

    assert cuda_runtime.configure_cuda_dll_paths() == [first, second]
    assert cuda_runtime.configure_cuda_dll_paths() == [first, second]

    assert [path for path, _handle in handles] == [str(first), str(second)]
    assert set(cuda_runtime._DLL_DIRECTORY_HANDLES.values()) == {
        handle for _path, handle in handles
    }
    entries = cuda_runtime.os.environ["PATH"].split(cuda_runtime.os.pathsep)
    assert entries.count(str(first)) == 1
    assert entries.count(str(second)) == 1
