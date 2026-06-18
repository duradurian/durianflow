import itertools
import logging
import platform
from threading import Lock

import numpy as np

from app.cuda_runtime import configure_cuda_dll_paths
from app.schemas import TranscriptSegment

logger = logging.getLogger(__name__)


CUDA_RUNTIME_ERROR_MARKERS = (
    "cublas",
    "cudnn",
    "cuda",
    "cublas64_12.dll",
    "cudnn64",
)


class WhisperTranscriber:
    def __init__(self, model_name: str, device: str, compute_type: str) -> None:
        self.model_name = model_name
        self.device = device
        self.compute_type = compute_type
        self._model = None
        self._segment_counter = itertools.count(1)
        self._load_lock = Lock()

    @property
    def model_loaded(self) -> bool:
        return self._model is not None

    def load(self) -> None:
        with self._load_lock:
            if self._model is not None:
                return
            if self.device == "cuda":
                configure_cuda_dll_paths()
            try:
                from faster_whisper import WhisperModel
            except ImportError as exc:
                raise RuntimeError("faster-whisper is not installed") from exc

            logger.info(
                "Loading faster-whisper model %s on %s (%s)",
                self.model_name,
                self.device,
                self.compute_type,
            )
            self._model = WhisperModel(
                self.model_name,
                device=self.device,
                compute_type=self.compute_type,
            )

    def transcribe(
        self,
        audio: np.ndarray,
        sample_rate: int,
        language: str | None,
        mode: str,
    ) -> list[TranscriptSegment]:
        if self._model is None:
            self.load()

        try:
            beam_size = 1 if mode == "fast" else 3
            segments, _info = self._model.transcribe(
                audio.astype(np.float32, copy=False),
                language=language,
                beam_size=beam_size,
                temperature=0,
                vad_filter=False,
                word_timestamps=False,
            )
            output: list[TranscriptSegment] = []
            for segment in segments:
                output.append(
                    TranscriptSegment(
                        id=f"seg_{next(self._segment_counter):06d}",
                        start=float(segment.start),
                        end=float(segment.end),
                        text=segment.text.strip(),
                    )
                )
            return output
        except RuntimeError as exc:
            if self.device == "cuda" and _is_cuda_runtime_error(exc):
                raise RuntimeError(_cuda_runtime_help(str(exc))) from exc
            raise


def _is_cuda_runtime_error(exc: RuntimeError) -> bool:
    message = str(exc).lower()
    return any(marker in message for marker in CUDA_RUNTIME_ERROR_MARKERS)


def _cuda_runtime_help(original_message: str) -> str:
    if platform.system() == "Windows":
        return (
            "CUDA runtime libraries are missing or not visible to Python. "
            f"Original error: {original_message}. "
            "For NVIDIA GPU mode on Windows, install NVIDIA CUDA Toolkit 12.x and cuDNN for CUDA 12, "
            "then make sure their bin directories are on PATH before starting uvicorn. "
            "At minimum, cublas64_12.dll must be discoverable. Restart the terminal after changing PATH."
        )
    return (
        "CUDA runtime libraries are missing or not visible to Python. "
        f"Original error: {original_message}. "
        "Use the provided NVIDIA Docker setup or install CUDA 12.x and cuDNN on the host."
    )
