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


class StatusEvent(BaseModel):
    type: Literal["status"] = "status"
    status: StatusValue
    message: str | None = None


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


AVAILABLE_MODELS = [
    "tiny",
    "base",
    "small",
    "medium",
    "large-v3",
    "large-v3-turbo",
    "distil-large-v3",
]
