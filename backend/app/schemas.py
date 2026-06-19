from typing import Literal

from pydantic import BaseModel, Field


AudioFormat = Literal["pcm_s16le"]
TranscriptionMode = Literal["fast", "accurate"]
StatusValue = Literal["listening", "speech_started", "speech_ended", "transcribing", "stopped"]


class StartMessage(BaseModel):
    type: Literal["start"]
    session_id: str
    sample_rate: int = 16000
    channels: int = 1
    format: AudioFormat = "pcm_s16le"
    language: str | None = "en"
    mode: TranscriptionMode = "fast"
    api_token: str | None = Field(default=None, exclude=True)


class StopMessage(BaseModel):
    type: Literal["stop"]


class ReadyEvent(BaseModel):
    type: Literal["ready"] = "ready"
    session_id: str
    model: str
    sample_rate: int


class StatusEvent(BaseModel):
    type: Literal["status"] = "status"
    status: StatusValue
    message: str | None = None


class ErrorEvent(BaseModel):
    type: Literal["error"] = "error"
    code: str
    message: str


class TranscriptSegment(BaseModel):
    id: str
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    text: str


class TranscriptEvent(BaseModel):
    type: Literal["partial", "final"]
    session_id: str
    segment_id: str
    text: str
    start: float
    end: float
    is_final: bool


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    app: str
    model_loaded: bool
    model_loading: bool = False
    model_error: str | None = None
    model_name: str
    model_source: str | None = None
    expected_model_path: str | None = None
    model_retry_after_seconds: int | None = None
    device: str
    compute_type: str
    active_device: str | None = None
    active_compute_type: str | None = None


class ModelsResponse(BaseModel):
    default: str
    available: list[str]


AVAILABLE_MODELS = [
    "tiny",
    "base",
    "small",
    "medium",
    "large-v3",
    "large-v3-turbo",
    "distil-large-v3",
]
