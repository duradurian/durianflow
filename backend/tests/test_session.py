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


class RecordingTranscriber(FakeTranscriber):
    def __init__(self) -> None:
        super().__init__()
        self.audio_lengths = []

    def transcribe(self, audio, sample_rate, language, mode):
        self.audio_lengths.append(len(audio))
        return super().transcribe(audio, sample_rate, language, mode)


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


def test_session_caps_long_continuous_speech() -> None:
    async def run() -> None:
        session = TranscriptionSession(
            session_id="test",
            sample_rate=16000,
            channels=1,
            language="en",
            mode="fast",
            settings=Settings(
                MAX_BUFFER_SECONDS=1,
                PARTIAL_INTERVAL_MS=100000,
                VAD_MIN_SILENCE_MS=100,
                VAD_MIN_SPEECH_MS=20,
            ),
            transcriber=FakeTranscriber(),
            semaphore=asyncio.Semaphore(1),
        )
        speech = np.full(16000 * 2, 0.05, dtype=np.float32)
        events = await session.accept_pcm16(float32_to_pcm16(speech))
        assert any(event["type"] == "final" for event in events)
        assert len(session.speech_buffer) == 0

    asyncio.run(run())


def test_subthreshold_energy_spike_is_discarded() -> None:
    async def run() -> None:
        transcriber = RecordingTranscriber()
        session = make_session()
        session.transcriber = transcriber

        short_spike = np.full(160, 0.05, dtype=np.float32)
        silence = np.zeros(1600, dtype=np.float32)
        await session.accept_pcm16(float32_to_pcm16(short_spike))
        await session.accept_pcm16(float32_to_pcm16(silence))
        events = await session.stop()

        assert transcriber.calls == 0
        assert len(session.speech_buffer) == 0
        assert not any(event["type"] == "final" for event in events)

    asyncio.run(run())


def test_final_timestamps_and_audio_use_bounded_speech_padding() -> None:
    async def run() -> None:
        transcriber = RecordingTranscriber()
        session = TranscriptionSession(
            session_id="test",
            sample_rate=16000,
            channels=1,
            language="en",
            mode="fast",
            settings=Settings(
                _env_file=None,
                PARTIAL_INTERVAL_MS=100000,
                VAD_MIN_SPEECH_MS=20,
                VAD_MIN_SILENCE_MS=100,
                VAD_SPEECH_PAD_MS=20,
            ),
            transcriber=transcriber,
            semaphore=asyncio.Semaphore(1),
        )
        leading_silence = np.zeros(1600, dtype=np.float32)
        speech = np.full(1600, 0.05, dtype=np.float32)
        silence_chunk = np.zeros(800, dtype=np.float32)

        await session.accept_pcm16(float32_to_pcm16(leading_silence))
        await session.accept_pcm16(float32_to_pcm16(speech))
        await session.accept_pcm16(float32_to_pcm16(silence_chunk))
        events = await session.accept_pcm16(float32_to_pcm16(silence_chunk))

        final = next(event for event in events if event["type"] == "final")
        assert transcriber.audio_lengths == [1920]
        assert final["start"] == 0.1
        assert final["end"] == 0.22

    asyncio.run(run())
