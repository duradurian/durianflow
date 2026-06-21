import asyncio
import base64

from app.config import Settings
from app.schemas import TranscriptSegment
from app.worker import TranscriptionWorker


SESSION_ID = "11111111-1111-4111-8111-111111111111"


class FakeTranscriber:
    model_loaded = True

    def transcribe(self, audio, sample_rate, language, mode):
        return [TranscriptSegment(id="fake", start=0, end=len(audio) / sample_rate, text="hello")]


def command(message_type: str, sequence: int, **fields):
    return {"protocolVersion": 1, "type": message_type, "sequence": sequence, **fields}


def test_worker_start_audio_stop_flow() -> None:
    async def run() -> None:
        events = []

        async def emit(record):
            events.append(record)

        worker = TranscriptionWorker(
            Settings(VAD_MIN_SPEECH_MS=20, VAD_MIN_SILENCE_MS=100), FakeTranscriber(), emit
        )
        await worker.handle(command("start", 1, sessionId=SESSION_ID, generation=3, sampleRate=16000,
                                    channels=1, format="pcm_s16le", language="en", mode="fast"))
        pcm = base64.b64encode((b"\x66\x06") * 8000).decode()
        await worker.handle(command("audio", 2, sessionId=SESSION_ID, generation=3, audioBase64=pcm))
        await worker.handle(command("stop", 3, sessionId=SESSION_ID, generation=3))

        assert any(item["type"] == "ready" for item in events)
        assert any(item["type"] == "final" and item["generation"] == 3 for item in events)
        assert any(item["type"] == "status" and item["status"] == "stopped" for item in events)

    asyncio.run(run())


def test_worker_cancel_suppresses_later_stop_transcript() -> None:
    async def run() -> None:
        events = []

        async def emit(record):
            events.append(record)

        worker = TranscriptionWorker(Settings(), FakeTranscriber(), emit)
        await worker.handle(command("start", 1, sessionId=SESSION_ID, generation=1, sampleRate=16000,
                                    channels=1, format="pcm_s16le", language="en", mode="fast"))
        await worker.handle(command("cancel", 2, sessionId=SESSION_ID, generation=1))
        await worker.handle(command("stop", 3, sessionId=SESSION_ID, generation=1))
        assert any(item["type"] == "canceled" for item in events)
        assert not any(item["type"] == "final" for item in events)

    asyncio.run(run())
