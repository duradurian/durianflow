import json
import logging
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from app.config import Settings
from app.schemas import ErrorEvent, ReadyEvent, StartMessage, StatusEvent, StopMessage
from app.security import bearer_token, is_valid_api_token, validate_websocket_trust
from app.session import TranscriptionSession, TranscriberProtocol

logger = logging.getLogger(__name__)


def error_event(code: str, message: str) -> dict[str, str]:
    return ErrorEvent(code=code, message=message).model_dump()


def validate_start_message(raw: Any, settings: Settings) -> StartMessage:
    message = StartMessage.model_validate(raw)
    if (
        message.sample_rate != settings.SAMPLE_RATE
        or message.channels != settings.CHANNELS
        or message.format != "pcm_s16le"
    ):
        raise ValueError("Expected pcm_s16le, mono, 16000 Hz audio.")
    return message


async def handle_transcription_socket(
    websocket: WebSocket,
    settings: Settings,
    transcriber: TranscriberProtocol,
    semaphore,
) -> None:
    trusted, reason = validate_websocket_trust(websocket, settings)
    if not trusted:
        await websocket.close(code=1008, reason=reason)
        return

    if settings.REQUIRE_API_TOKEN:
        token = (
            websocket.headers.get("x-api-token")
            or bearer_token(websocket.headers.get("authorization"))
            or websocket.query_params.get("token")
        )
        if not is_valid_api_token(token, settings):
            await websocket.close(code=1008, reason="Unauthorized")
            return

    await websocket.accept()
    session: TranscriptionSession | None = None

    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break

            if text := message.get("text"):
                try:
                    payload = json.loads(text)
                except json.JSONDecodeError:
                    await websocket.send_json(error_event("INVALID_JSON", "Control message is not valid JSON."))
                    continue

                message_type = payload.get("type")
                if message_type == "start":
                    if session:
                        await websocket.send_json(error_event("INVALID_MESSAGE", "Session has already started."))
                        continue
                    if not getattr(transcriber, "model_loaded", True):
                        await websocket.send_json(
                            error_event("MODEL_UNAVAILABLE", "Transcription model is not loaded.")
                        )
                        continue
                    try:
                        start = validate_start_message(payload, settings)
                    except (ValidationError, ValueError) as exc:
                        await websocket.send_json(error_event("INVALID_AUDIO_FORMAT", str(exc)))
                        continue
                    session = TranscriptionSession(
                        session_id=start.session_id,
                        sample_rate=start.sample_rate,
                        channels=start.channels,
                        language=start.language,
                        mode=start.mode,
                        settings=settings,
                        transcriber=transcriber,
                        semaphore=semaphore,
                    )
                    await websocket.send_json(
                        ReadyEvent(
                            session_id=start.session_id,
                            model=settings.MODEL_NAME,
                            sample_rate=settings.SAMPLE_RATE,
                        ).model_dump()
                    )
                    await websocket.send_json(StatusEvent(status="listening").model_dump())
                elif message_type == "stop":
                    try:
                        StopMessage.model_validate(payload)
                        if session:
                            for event in await session.stop():
                                await websocket.send_json(event)
                        else:
                            await websocket.send_json(StatusEvent(status="stopped").model_dump())
                    except ValidationError as exc:
                        await websocket.send_json(error_event("INVALID_MESSAGE", str(exc)))
                    break
                else:
                    await websocket.send_json(error_event("INVALID_MESSAGE", "Unsupported control message type."))

            elif "bytes" in message and message.get("bytes") is not None:
                binary = message.get("bytes") or b""
                if not session:
                    await websocket.send_json(
                        error_event("MISSING_START", "Send a start control message before audio frames.")
                    )
                    continue
                try:
                    for event in await session.accept_pcm16(binary):
                        await websocket.send_json(event)
                except ValueError as exc:
                    session.metrics.errors += 1
                    await websocket.send_json(error_event("INVALID_AUDIO_FRAME", str(exc)))
                except Exception as exc:
                    logger.exception("Session failed")
                    session.metrics.errors += 1
                    await websocket.send_json(error_event("INFERENCE_FAILURE", str(exc)))

    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected")
