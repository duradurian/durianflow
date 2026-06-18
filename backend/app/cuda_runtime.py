import logging
import os
import platform
import site
from pathlib import Path

logger = logging.getLogger(__name__)


def configure_cuda_dll_paths() -> list[Path]:
    if platform.system() != "Windows":
        return []

    added: list[Path] = []
    candidates = _candidate_cuda_bin_dirs()
    for directory in candidates:
        if not directory.exists():
            continue
        os.add_dll_directory(str(directory))
        os.environ["PATH"] = f"{directory}{os.pathsep}{os.environ.get('PATH', '')}"
        added.append(directory)

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
