import asyncio
import base64
import threading
import types

from app.config import Settings
from app.schemas import TranscriptSegment
from app.worker import TranscriptionWorker


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
        await worker.handle(command("start", 1, sessionId="s", generation=3, sample_rate=16000,
                                    channels=1, format="pcm_s16le", language="en", mode="fast"))
        pcm = base64.b64encode((b"\x66\x06") * 8000).decode()
        await worker.handle(command("audio", 2, sessionId="s", generation=3, audioBase64=pcm))
        await worker.handle(command("stop", 3, sessionId="s", generation=3))

        assert any(item["type"] == "ready" for item in events)
        final = next(item for item in events if item["type"] == "final")
        assert final["generation"] == 3
        assert final["segmentId"].startswith("seg_")
        assert final["isFinal"] is True
        assert "segment_id" not in final
        assert any(item["type"] == "status" and item["status"] == "stopped" for item in events)

    asyncio.run(run())


def test_worker_cancel_suppresses_later_stop_transcript() -> None:
    async def run() -> None:
        events = []

        async def emit(record):
            events.append(record)

        worker = TranscriptionWorker(Settings(), FakeTranscriber(), emit)
        await worker.handle(command("start", 1, sessionId="s", generation=1, sample_rate=16000,
                                    channels=1, format="pcm_s16le", language="en", mode="fast"))
        await worker.handle(command("cancel", 2, sessionId="s", generation=1))
        await worker.handle(command("stop", 3, sessionId="s", generation=1))
        assert any(item["type"] == "canceled" for item in events)
        assert not any(item["type"] == "final" for item in events)

    asyncio.run(run())


def test_scheduled_stop_keeps_cancel_responsive_and_suppresses_final() -> None:
    async def run() -> None:
        events = []
        inference_started = threading.Event()
        release_inference = threading.Event()

        class BlockingTranscriber(FakeTranscriber):
            def transcribe(self, audio, sample_rate, language, mode):
                inference_started.set()
                assert release_inference.wait(timeout=5)
                return super().transcribe(audio, sample_rate, language, mode)

        async def emit(record):
            events.append(record)

        worker = TranscriptionWorker(
            Settings(_env_file=None, PARTIAL_INTERVAL_MS=100000, VAD_MIN_SPEECH_MS=20),
            BlockingTranscriber(),
            emit,
        )
        await worker.handle(command(
            "start", 0, sessionId="s", generation=1, sampleRate=16000,
            channels=1, format="pcm_s16le", language="en", mode="fast",
        ))
        pcm = base64.b64encode((b"\x66\x06") * 1600).decode()
        await worker.handle(command("audio", 1, sessionId="s", generation=1, audioBase64=pcm))

        worker.schedule_stop(command("stop", 2, sessionId="s", generation=1))
        for _ in range(100):
            if inference_started.is_set():
                break
            await asyncio.sleep(0.01)
        assert inference_started.is_set()

        post_stop_audio = command("audio", 3, sessionId="s", generation=1, audioBase64=pcm)
        await worker.handle(post_stop_audio)
        await asyncio.wait_for(
            worker.handle(command("cancel", 4, sessionId="s", generation=1)),
            timeout=0.2,
        )
        await worker.handle(command(
            "start", 0, sessionId="new", generation=2, sampleRate=16000,
            channels=1, format="pcm_s16le", language="en", mode="fast",
        ))
        release_inference.set()
        await worker.drain_stops()

        assert any(item["type"] == "canceled" for item in events)
        assert not any(item["type"] in {"final", "stopped"} for item in events)
        assert any(
            item["type"] == "error"
            and item.get("sequence") == 3
            and "already stopping" in item["message"]
            for item in events
        )
        assert worker.active is not None
        assert worker.active.generation == 2

    asyncio.run(run())


def test_audio_credit_accounts_for_frames_still_queued() -> None:
    async def run() -> None:
        events = []

        async def emit(record):
            events.append(record)

        worker = TranscriptionWorker(Settings(_env_file=None), FakeTranscriber(), emit)
        await worker.handle(command(
            "start", 0, sessionId="s", generation=1, sampleRate=16000,
            channels=1, format="pcm_s16le", language="en", mode="fast",
        ))
        raw = b"\x00\x00" * 160
        encoded = base64.b64encode(raw).decode()
        worker.schedule_audio(command("audio", 1, sessionId="s", generation=1, audioBase64=encoded))
        worker.schedule_audio(command("audio", 2, sessionId="s", generation=1, audioBase64=encoded))
        worker.schedule_stop(command("stop", 3, sessionId="s", generation=1))
        await worker.drain_stops()

        accepted = [item for item in events if item["type"] == "accepted" and item["sequence"] > 0]
        assert [item["sequence"] for item in accepted] == [1, 2]
        assert accepted[0]["creditBytes"] == 512 * 1024 - len(raw)
        assert accepted[1]["creditBytes"] == 512 * 1024
        stopped_index = next(index for index, item in enumerate(events) if item["type"] == "stopped")
        assert all(events.index(item) < stopped_index for item in accepted)

    asyncio.run(run())


def test_model_load_retries_after_configured_delay() -> None:
    async def run() -> None:
        events = []

        class FlakyTranscriber(FakeTranscriber):
            model_loaded = False

            def __init__(self):
                self.load_calls = 0

            def load(self):
                self.load_calls += 1
                if self.load_calls == 1:
                    raise RuntimeError("temporary failure")

        async def emit(record):
            events.append(record)

        transcriber = FlakyTranscriber()
        worker = TranscriptionWorker(
            Settings(_env_file=None, MODEL_LOAD_RETRY_SECONDS=0.01),
            transcriber,
            emit,
        )

        await asyncio.wait_for(worker.load_model(), timeout=1)

        assert transcriber.load_calls == 2
        assert worker.model_state == "ready"
        assert [item.get("state") for item in events] == [
            "loading",
            "unavailable",
            "loading",
            "ready",
        ]

    asyncio.run(run())


def test_cancel_pending_does_not_wait_for_blocked_stop_inference() -> None:
    async def run() -> None:
        inference_started = threading.Event()
        release_inference = threading.Event()
        events = []

        class BlockingTranscriber(FakeTranscriber):
            def transcribe(self, audio, sample_rate, language, mode):
                inference_started.set()
                release_inference.wait(timeout=5)
                return super().transcribe(audio, sample_rate, language, mode)

        async def emit(record):
            events.append(record)

        worker = TranscriptionWorker(
            Settings(_env_file=None, PARTIAL_INTERVAL_MS=100000, VAD_MIN_SPEECH_MS=20),
            BlockingTranscriber(),
            emit,
        )
        await worker.handle(command(
            "start", 0, sessionId="s", generation=1, sampleRate=16000,
            channels=1, format="pcm_s16le", language="en", mode="fast",
        ))
        pcm = base64.b64encode((b"\x66\x06") * 1600).decode()
        await worker.handle(command("audio", 1, sessionId="s", generation=1, audioBase64=pcm))
        worker.schedule_stop(command("stop", 2, sessionId="s", generation=1))
        for _ in range(100):
            if inference_started.is_set():
                break
            await asyncio.sleep(0.01)
        assert inference_started.is_set()

        await asyncio.wait_for(worker.cancel_pending(), timeout=0.2)
        release_inference.set()
        await asyncio.sleep(0.01)

        assert worker.active is None
        assert not any(item["type"] in {"final", "stopped"} for item in events)

    asyncio.run(run())


def test_cancel_during_session_event_emission_suppresses_remaining_output() -> None:
    async def run() -> None:
        events = []
        worker = None

        async def emit(record):
            events.append(record)
            if record.get("status") == "speech_started":
                assert worker is not None
                await worker.handle(command("cancel", 2, sessionId="s", generation=1))

        worker = TranscriptionWorker(
            Settings(_env_file=None, VAD_MIN_SPEECH_MS=20),
            FakeTranscriber(),
            emit,
        )
        await worker.handle(command(
            "start", 0, sessionId="s", generation=1, sampleRate=16000,
            channels=1, format="pcm_s16le", language="en", mode="fast",
        ))
        pcm = base64.b64encode((b"\x66\x06") * 1600).decode()
        await worker.handle(command("audio", 1, sessionId="s", generation=1, audioBase64=pcm))

        assert any(item["type"] == "canceled" for item in events)
        assert not any(item["type"] == "accepted" and item["sequence"] == 1 for item in events)

    asyncio.run(run())


def test_model_state_reports_resolved_backend_and_capabilities() -> None:
    async def run() -> None:
        events = []

        class MetadataTranscriber(FakeTranscriber):
            model_loaded = False
            requested_backend = "auto"
            active_backend = "mlx"
            active_device = "metal"
            active_compute_type = "float16"
            available_backends = ["mlx", "cpu"]
            capabilities = (
                types.SimpleNamespace(
                    as_dict=lambda: {
                        "name": "mlx",
                        "available": True,
                        "device": "metal",
                        "computeType": "float16",
                        "reason": None,
                    }
                ),
            )

            def load(self):
                self.model_loaded = True

        async def emit(record):
            events.append(record)

        worker = TranscriptionWorker(
            Settings(_env_file=None, DEVICE="auto"),
            MetadataTranscriber(),
            emit,
        )
        await worker.load_model()

        ready = events[-1]
        assert ready["state"] == "ready"
        assert ready["requestedBackend"] == "auto"
        assert ready["backend"] == "mlx"
        assert ready["device"] == "metal"
        assert ready["availableBackends"] == ["mlx", "cpu"]

    asyncio.run(run())
