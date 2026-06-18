import asyncio
import logging
from dataclasses import dataclass, field
from time import monotonic
from typing import Protocol

import numpy as np

from app.audio import pcm16_bytes_to_float32, samples_to_seconds, seconds_to_samples
from app.config import Settings
from app.merge import normalize_whitespace, remove_duplicate_overlap, remove_final_prefix_from_partial
from app.metrics import SessionMetrics
from app.schemas import StatusEvent, TranscriptEvent, TranscriptSegment
from app.vad import EnergyVad

logger = logging.getLogger(__name__)


class TranscriberProtocol(Protocol):
    def transcribe(
        self,
        audio: np.ndarray,
        sample_rate: int,
        language: str | None,
        mode: str,
    ) -> list[TranscriptSegment]:
        ...


@dataclass
class TranscriptionSession:
    session_id: str
    sample_rate: int
    channels: int
    language: str | None
    mode: str
    settings: Settings
    transcriber: TranscriberProtocol
    semaphore: asyncio.Semaphore
    created_at: float = field(default_factory=monotonic)
    audio_buffer: np.ndarray = field(default_factory=lambda: np.empty(0, dtype=np.float32))
    speech_buffer: np.ndarray = field(default_factory=lambda: np.empty(0, dtype=np.float32))
    finalized_segments: list[TranscriptSegment] = field(default_factory=list)
    current_partial: TranscriptEvent | None = None
    last_partial_at: float = field(default_factory=monotonic)
    started: bool = True
    stopped: bool = False
    metrics: SessionMetrics = field(default_factory=SessionMetrics)
    partial_in_flight: bool = False
    final_in_flight: bool = False
    speech_pad_remaining_samples: int = 0

    def __post_init__(self) -> None:
        self.vad_state = EnergyVad(
            sample_rate=self.sample_rate,
            threshold=self.settings.VAD_ENERGY_THRESHOLD,
            min_speech_ms=self.settings.VAD_MIN_SPEECH_MS,
            min_silence_ms=self.settings.VAD_MIN_SILENCE_MS,
        )

    async def accept_pcm16(self, payload: bytes) -> list[dict]:
        if self.stopped:
            return []
        if self.metrics.age_seconds > self.settings.MAX_SESSION_SECONDS:
            raise RuntimeError("Session exceeded maximum duration")

        frame = pcm16_bytes_to_float32(payload)
        self._append_audio(frame)
        self.metrics.audio_seconds_received += samples_to_seconds(len(frame), self.sample_rate)

        events: list[dict] = []
        vad_result = self.vad_state.process(frame)
        if vad_result.speech_started:
            self.speech_pad_remaining_samples = seconds_to_samples(
                self.settings.VAD_SPEECH_PAD_MS / 1000,
                self.sample_rate,
            )
            events.append(StatusEvent(status="speech_started").model_dump())
        if vad_result.is_speech:
            self.speech_buffer = np.concatenate((self.speech_buffer, frame))
            self.speech_pad_remaining_samples = seconds_to_samples(
                self.settings.VAD_SPEECH_PAD_MS / 1000,
                self.sample_rate,
            )
            partial = await self._maybe_partial()
            if partial:
                events.append(partial.model_dump())
            if samples_to_seconds(len(self.speech_buffer), self.sample_rate) >= self.settings.MAX_BUFFER_SECONDS:
                events.append(
                    StatusEvent(status="speech_ended", message="Maximum utterance length reached.").model_dump()
                )
                final = await self._finalize_current_speech()
                if final:
                    events.append(final.model_dump())
        elif len(self.speech_buffer) > 0:
            pad = min(len(frame), self.speech_pad_remaining_samples)
            if pad > 0:
                self.speech_buffer = np.concatenate((self.speech_buffer, frame[:pad]))
                self.speech_pad_remaining_samples -= pad

        if vad_result.speech_ended and len(self.speech_buffer) > 0:
            events.append(StatusEvent(status="speech_ended").model_dump())
            final = await self._finalize_current_speech()
            if final:
                events.append(final.model_dump())

        return events

    async def stop(self) -> list[dict]:
        self.stopped = True
        events: list[dict] = []
        if len(self.speech_buffer) > 0:
            final = await self._finalize_current_speech()
            if final:
                events.append(final.model_dump())
        elif self.current_partial is not None:
            events.append(self._promote_current_partial().model_dump())
        events.append(StatusEvent(status="stopped").model_dump())
        return events

    def _append_audio(self, frame: np.ndarray) -> None:
        self.audio_buffer = np.concatenate((self.audio_buffer, frame))
        max_samples = seconds_to_samples(self.settings.MAX_BUFFER_SECONDS, self.sample_rate)
        if len(self.audio_buffer) > max_samples:
            self.audio_buffer = self.audio_buffer[-max_samples:]
        if samples_to_seconds(len(self.audio_buffer), self.sample_rate) > self.settings.MAX_BUFFER_SECONDS:
            raise RuntimeError("Audio buffer exceeded maximum size")

    async def _maybe_partial(self) -> TranscriptEvent | None:
        now = monotonic()
        interval = self.settings.PARTIAL_INTERVAL_MS / 1000
        if now - self.last_partial_at < interval or self.partial_in_flight or self.final_in_flight:
            return None

        self.last_partial_at = now
        self.partial_in_flight = True
        try:
            max_samples = seconds_to_samples(self.settings.ROLLING_WINDOW_SECONDS, self.sample_rate)
            audio = self.speech_buffer[-max_samples:].copy()
            if len(audio) == 0:
                return None
            segments = await self._run_transcription(audio)
            text = normalize_whitespace(" ".join(segment.text for segment in segments))
            previous_text = " ".join(segment.text for segment in self.finalized_segments)
            text = remove_final_prefix_from_partial(previous_text, text)
            if not text:
                return None
            start = max(0.0, self.metrics.audio_seconds_received - samples_to_seconds(len(audio), self.sample_rate))
            event = TranscriptEvent(
                type="partial",
                session_id=self.session_id,
                segment_id=f"seg_{len(self.finalized_segments) + 1:06d}",
                text=text,
                start=start,
                end=self.metrics.audio_seconds_received,
                is_final=False,
            )
            self.current_partial = event
            self.metrics.partial_transcriptions += 1
            return event
        finally:
            self.partial_in_flight = False

    async def _finalize_current_speech(self) -> TranscriptEvent | None:
        if self.final_in_flight:
            return None
        self.final_in_flight = True
        try:
            audio = self.speech_buffer.copy()
            self.speech_buffer = np.empty(0, dtype=np.float32)
            if len(audio) == 0:
                return None

            segments = await self._run_transcription(audio)
            text = normalize_whitespace(" ".join(segment.text for segment in segments))
            previous_text = " ".join(segment.text for segment in self.finalized_segments)
            text = remove_duplicate_overlap(previous_text, text)
            if not text:
                if self.current_partial is not None:
                    return self._promote_current_partial()
                return None

            duration = samples_to_seconds(len(audio), self.sample_rate)
            end = self.metrics.audio_seconds_received
            start = max(0.0, end - duration)
            segment = TranscriptSegment(
                id=f"seg_{len(self.finalized_segments) + 1:06d}",
                start=start,
                end=end,
                text=text,
            )
            self.finalized_segments.append(segment)
            self.current_partial = None
            self.metrics.final_transcriptions += 1
            self.speech_pad_remaining_samples = 0
            return TranscriptEvent(
                type="final",
                session_id=self.session_id,
                segment_id=segment.id,
                text=segment.text,
                start=segment.start,
                end=segment.end,
                is_final=True,
            )
        finally:
            self.final_in_flight = False

    def _promote_current_partial(self) -> TranscriptEvent:
        partial = self.current_partial
        assert partial is not None
        segment = TranscriptSegment(
            id=partial.segment_id,
            start=partial.start,
            end=partial.end,
            text=partial.text,
        )
        self.finalized_segments.append(segment)
        self.current_partial = None
        self.metrics.final_transcriptions += 1
        return TranscriptEvent(
            type="final",
            session_id=self.session_id,
            segment_id=segment.id,
            text=segment.text,
            start=segment.start,
            end=segment.end,
            is_final=True,
        )

    async def _run_transcription(self, audio: np.ndarray) -> list[TranscriptSegment]:
        async with self.semaphore:
            return await asyncio.to_thread(
                self.transcriber.transcribe,
                audio,
                self.sample_rate,
                self.language,
                self.mode,
            )
