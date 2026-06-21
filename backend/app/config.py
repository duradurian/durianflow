from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


BACKEND_ROOT = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    APP_NAME: str = "durianflow-backend"
    MODEL_NAME: str = "large-v3-turbo"
    MODELS_DIR: str = "./models"
    # Models are installed deliberately into MODELS_DIR.  Arbitrary model paths
    # and implicit network downloads turn a local transcription process into an
    # uncontrolled code/data loading boundary, so both are disabled by default.
    MODEL_PATH: str | None = None
    ALLOW_MODEL_DOWNLOAD: bool = False
    # Custom models are an explicit user-managed exception to official model
    # provenance.  The JSON file only selects an ID below CUSTOM_MODELS_DIR;
    # it never accepts an arbitrary model path or repository identifier.
    CUSTOM_MODEL_CONFIG_PATH: str | None = None
    CUSTOM_MODELS_DIR: str = "./custom-models"
    LOG_DIR: str | None = None
    # Recognize, but never use, retired server settings so an upgrade fails
    # neither open nor silently.  They are retained only for configuration-file
    # compatibility and must not create a network listener.
    HOST: str | None = None
    PORT: int | None = None
    DURIANFLOW_SERVER_MODE: bool | None = None
    REQUIRE_API_TOKEN: bool | None = None
    FALLBACK_TO_CPU_ON_CUDA_ERROR: bool = True
    DEVICE: str = "cuda"
    COMPUTE_TYPE: str = "float16"
    LANGUAGE: str = "en"
    SAMPLE_RATE: int = 16000
    CHANNELS: int = 1
    VAD_MIN_SILENCE_MS: int = 600
    VAD_SPEECH_PAD_MS: int = 300
    PARTIAL_INTERVAL_MS: int = 1000
    ROLLING_WINDOW_SECONDS: int = 6
    MAX_SESSION_SECONDS: int = 7200
    MAX_BUFFER_SECONDS: int = 60
    MAX_CONCURRENT_TRANSCRIPTIONS: int = 1
    MODEL_LOAD_RETRY_SECONDS: int = 30
    VAD_ENERGY_THRESHOLD: float = Field(default=0.01, gt=0)
    VAD_MIN_SPEECH_MS: int = 120

    # Ignore retired server-only variables in existing local .env files.
    model_config = SettingsConfigDict(
        env_file=str(BACKEND_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="forbid",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
