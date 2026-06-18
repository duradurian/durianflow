import asyncio

import numpy as np

from app.audio import float32_to_pcm16
from app.config import Settings
from app.schemas import TranscriptSegment
from app.session import TranscriptionSession


class FakeTranscriber:
    def __init__(self) -> None:
        self.calls = 0

    def transcribe(self, audio, sample_rate, language, mode):
        self.calls += 1
        return [TranscriptSegment(id="fake", start=0.0, end=len(audio) / sample_rate, text="hello world")]


def make_session() -> TranscriptionSession:
    return TranscriptionSession(
        session_id="test",
        sample_rate=16000,
        channels=1,
        language="en",
        mode="fast",
        settings=Settings(PARTIAL_INTERVAL_MS=1, VAD_MIN_SILENCE_MS=100, VAD_MIN_SPEECH_MS=20),
        transcriber=FakeTranscriber(),
        semaphore=asyncio.Semaphore(1),
    )


def test_session_emits_final_after_silence() -> None:
    async def run() -> None:
        session = make_session()
        speech = np.full(16000 // 2, 0.05, dtype=np.float32)
        silence = np.zeros(16000 // 5, dtype=np.float32)

        events = []
        events.extend(await session.accept_pcm16(float32_to_pcm16(speech)))
        events.extend(await session.accept_pcm16(float32_to_pcm16(silence)))

        assert any(event["type"] == "final" for event in events)
        assert session.finalized_segments[0].text == "hello world"

    asyncio.run(run())


def test_stop_finalizes_active_speech() -> None:
    async def run() -> None:
        session = make_session()
        speech = np.full(16000 // 2, 0.05, dtype=np.float32)
        await session.accept_pcm16(float32_to_pcm16(speech))
        events = await session.stop()
        assert events[-1]["status"] == "stopped"
        assert any(event["type"] == "final" for event in events)

    asyncio.run(run())
