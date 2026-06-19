from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    APP_NAME: str = "openflow-backend"
    HOST: str = "127.0.0.1"
    PORT: int = 8000
    OPENFLOW_SERVER_MODE: bool = False
    MODEL_NAME: str = "large-v3-turbo"
    MODELS_DIR: str = "./models"
    MODEL_PATH: str | None = None
    ALLOW_MODEL_DOWNLOAD: bool = False
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
    REQUIRE_API_TOKEN: bool = False
    API_TOKEN: str | None = None
    ALLOWED_ORIGINS: str = ""
    MAX_CONCURRENT_TRANSCRIPTIONS: int = 1
    MODEL_LOAD_RETRY_SECONDS: int = 30
    VAD_ENERGY_THRESHOLD: float = Field(default=0.01, gt=0)
    VAD_MIN_SPEECH_MS: int = 120

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


@lru_cache
def get_settings() -> Settings:
    return Settings()
