from typing import Literal

from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.model_manifest import available_model_ids


AudioFormat = Literal["pcm_s16le"]
TranscriptionMode = Literal["fast", "accurate"]
StatusValue = Literal["listening", "speech_started", "speech_ended", "transcribing", "stopped"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, str_strip_whitespace=True)


class StartMessage(StrictModel):
    type: Literal["start"]
    session_id: UUID = Field(alias="sessionId")
    sample_rate: int = Field(default=16000, alias="sampleRate")
    channels: int = 1
    format: AudioFormat = "pcm_s16le"
    language: str | None = Field(default="en", max_length=16)
    mode: TranscriptionMode = "fast"


class StatusEvent(StrictModel):
    type: Literal["status"] = "status"
    status: StatusValue
    message: str | None = None


class TranscriptSegment(StrictModel):
    id: str
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    text: str


class TranscriptEvent(StrictModel):
    type: Literal["partial", "final"]
    session_id: UUID
    segment_id: str
    text: str
    start: float
    end: float
    is_final: bool


AVAILABLE_MODELS = list(available_model_ids())
