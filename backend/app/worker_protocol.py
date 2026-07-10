"""Bounded framing and validation for the local transcription worker.

The worker intentionally has no network listener.  Its stdin/stdout transport is
one length-prefixed UTF-8 JSON record per command/event.  Audio is base64 encoded
inside an ``audio`` command for the first worker implementation; the encoded and
decoded sizes are both capped before allocating or decoding it.
"""

from __future__ import annotations

import base64
import json
import struct
from collections.abc import Mapping
from typing import Any, BinaryIO

from pydantic import ValidationError

from app.config import Settings
from app.schemas import StartMessage

PROTOCOL_VERSION = 1
MAX_CONTROL_BYTES = 64 * 1024
MAX_AUDIO_BYTES = 64 * 1024
MAX_FRAME_BYTES = MAX_CONTROL_BYTES + (MAX_AUDIO_BYTES * 4 // 3) + 1024


class ProtocolError(ValueError):
    """An invalid record; callers must fail the stream closed."""


def validate_start_message(raw: Any, settings: Settings) -> StartMessage:
    message = StartMessage.model_validate(raw)
    if (
        message.sample_rate != settings.SAMPLE_RATE
        or message.channels != settings.CHANNELS
        or message.format != "pcm_s16le"
    ):
        raise ValueError(
            f"Expected pcm_s16le, {settings.CHANNELS} channel(s), "
            f"{settings.SAMPLE_RATE} Hz audio."
        )
    return message


def read_record(stream: BinaryIO) -> dict[str, Any] | None:
    """Read one bounded JSON record, returning ``None`` only for clean EOF."""
    header = _read_exact(stream, 4, allow_eof=True)
    if header is None:
        return None
    length = struct.unpack(">I", header)[0]
    if not 1 <= length <= MAX_FRAME_BYTES:
        raise ProtocolError("invalid record length")
    raw = _read_exact(stream, length)
    try:
        decoded = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProtocolError("record is not valid UTF-8 JSON") from exc
    if not isinstance(decoded, dict):
        raise ProtocolError("record must be a JSON object")
    return decoded


def write_record(stream: BinaryIO, record: Mapping[str, Any]) -> None:
    try:
        raw = json.dumps(record, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ProtocolError("record is not JSON serializable") from exc
    if not 1 <= len(raw) <= MAX_FRAME_BYTES:
        raise ProtocolError("outgoing record exceeds size limit")
    stream.write(struct.pack(">I", len(raw)))
    stream.write(raw)
    stream.flush()


def validate_command(record: Mapping[str, Any], settings: Settings) -> dict[str, Any]:
    """Validate common envelope fields and normalize an inbound command."""
    if type(record.get("protocolVersion")) is not int or record["protocolVersion"] != PROTOCOL_VERSION:
        raise ProtocolError("unsupported protocolVersion")
    command_type = record.get("type")
    if command_type not in {"hello", "start", "audio", "stop", "cancel", "shutdown"}:
        raise ProtocolError("unsupported command type")
    sequence = record.get("sequence")
    if type(sequence) is not int or sequence < 0:
        raise ProtocolError("sequence must be a non-negative integer")
    if command_type in {"start", "audio", "stop", "cancel"}:
        session_id = record.get("sessionId")
        if not isinstance(session_id, str) or not session_id.strip() or len(session_id) > 256:
            raise ProtocolError("sessionId is required")
        if type(record.get("generation")) is not int or record["generation"] < 0:
            raise ProtocolError("generation must be a non-negative integer")
    command = dict(record)
    if command_type == "start":
        start = dict(record)
        start["session_id"] = start.pop("sessionId")
        if "sampleRate" in start:
            if "sample_rate" in start:
                raise ProtocolError("start cannot contain both sampleRate and sample_rate")
            start["sample_rate"] = start.pop("sampleRate")
        start.pop("protocolVersion", None)
        start.pop("generation", None)
        start.pop("sequence", None)
        try:
            command["start"] = validate_start_message(start, settings)
        except (ValidationError, ValueError) as exc:
            raise ProtocolError(str(exc)) from exc
    elif command_type == "audio":
        encoded = record.get("audioBase64")
        if not isinstance(encoded, str):
            raise ProtocolError("audioBase64 is required")
        # Reject oversized encoded data before base64 allocates a decoded payload.
        if len(encoded) > ((MAX_AUDIO_BYTES + 2) // 3) * 4:
            raise ProtocolError("audio frame exceeds size limit")
        try:
            audio = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError) as exc:
            raise ProtocolError("audioBase64 is invalid") from exc
        if len(audio) > MAX_AUDIO_BYTES:
            raise ProtocolError("audio frame exceeds size limit")
        if not audio or len(audio) % 2:
            raise ProtocolError("audio frame must be non-empty PCM16")
        command["audio"] = audio
    return command


def event(event_type: str, **fields: Any) -> dict[str, Any]:
    return {"protocolVersion": PROTOCOL_VERSION, "type": event_type, **fields}


def _read_exact(stream: BinaryIO, size: int, allow_eof: bool = False) -> bytes | None:
    chunks = bytearray()
    while len(chunks) < size:
        chunk = stream.read(size - len(chunks))
        if not chunk:
            if not chunks and allow_eof:
                return None
            raise ProtocolError("truncated record")
        chunks.extend(chunk)
    return bytes(chunks)
