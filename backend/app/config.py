from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


BACKEND_ROOT = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    APP_NAME: str = "durianflow-backend"
    MODEL_NAME: str = Field(default="large-v3-turbo", min_length=1)
    MODELS_DIR: str = Field(default="./models", min_length=1)
    MODEL_PATH: str | None = None
    ALLOW_MODEL_DOWNLOAD: bool = True
    FALLBACK_TO_CPU_ON_CUDA_ERROR: bool = True
    DEVICE: Literal["auto", "cpu", "cuda"] = "cuda"
    COMPUTE_TYPE: str = Field(default="float16", min_length=1)
    LANGUAGE: str = "en"
    SAMPLE_RATE: int = Field(default=16000, ge=16000, le=16000)
    CHANNELS: int = Field(default=1, ge=1, le=1)
    VAD_MIN_SILENCE_MS: int = Field(default=600, ge=0)
    VAD_SPEECH_PAD_MS: int = Field(default=300, ge=0)
    PARTIAL_INTERVAL_MS: int = Field(default=1000, ge=0)
    ROLLING_WINDOW_SECONDS: int = Field(default=6, gt=0)
    MAX_SESSION_SECONDS: int = Field(default=7200, gt=0)
    MAX_BUFFER_SECONDS: int = Field(default=60, gt=0)
    MAX_CONCURRENT_TRANSCRIPTIONS: int = Field(default=1, gt=0)
    MODEL_LOAD_RETRY_SECONDS: float = Field(default=30, ge=0)
    VAD_ENERGY_THRESHOLD: float = Field(default=0.01, gt=0)
    VAD_MIN_SPEECH_MS: int = Field(default=120, ge=0)

    # Ignore retired server-only variables in existing local .env files.
    model_config = SettingsConfigDict(
        env_file=str(BACKEND_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
