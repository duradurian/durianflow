import logging
import os
import platform
import site
from pathlib import Path
from threading import Lock

logger = logging.getLogger(__name__)
_DLL_DIRECTORY_HANDLES: dict[str, object] = {}
_DLL_PATH_LOCK = Lock()


def configure_cuda_dll_paths() -> list[Path]:
    if platform.system() != "Windows":
        return []

    added: list[Path] = []
    with _DLL_PATH_LOCK:
        path_entries = os.environ.get("PATH", "").split(os.pathsep)
        known_path_entries = {os.path.normcase(os.path.abspath(entry)) for entry in path_entries if entry}
        seen_candidates: set[str] = set()
        for directory in _candidate_cuda_bin_dirs():
            if not directory.is_dir():
                continue
            absolute = Path(os.path.abspath(directory))
            key = os.path.normcase(str(absolute))
            if key in seen_candidates:
                continue
            seen_candidates.add(key)
            if key not in _DLL_DIRECTORY_HANDLES:
                try:
                    # Retaining this handle is required: closing or finalizing it
                    # removes the directory from Windows DLL resolution.
                    _DLL_DIRECTORY_HANDLES[key] = os.add_dll_directory(str(absolute))
                except OSError as exc:
                    logger.warning("Could not register CUDA DLL directory %s: %s", absolute, exc)
                    continue
            if key not in known_path_entries:
                path_entries.insert(0, str(absolute))
                known_path_entries.add(key)
            added.append(absolute)
        os.environ["PATH"] = os.pathsep.join(path_entries)

    if added:
        logger.info("Registered CUDA DLL directories: %s", ", ".join(str(path) for path in added))
    return added


def _candidate_cuda_bin_dirs() -> list[Path]:
    dirs: list[Path] = []
    for root in site.getsitepackages():
        site_packages = Path(root)
        dirs.extend(
            [
                site_packages / "nvidia" / "cublas" / "bin",
                site_packages / "nvidia" / "cudnn" / "bin",
                site_packages / "nvidia" / "cuda_nvrtc" / "bin",
                site_packages / "ctranslate2",
            ]
        )

    cuda_root = os.environ.get("CUDA_PATH")
    if cuda_root:
        dirs.append(Path(cuda_root) / "bin")

    return dirs
