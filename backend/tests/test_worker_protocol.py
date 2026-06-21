import base64
import io
import struct

import pytest

from app.config import Settings
from app.worker_protocol import MAX_AUDIO_BYTES, ProtocolError, read_record, validate_command, write_record


def envelope(message_type: str, **fields):
    return {"protocolVersion": 1, "type": message_type, "sequence": 0, **fields}


def test_framing_round_trip() -> None:
    stream = io.BytesIO()
    write_record(stream, {"protocolVersion": 1, "type": "hello", "sequence": 0})
    stream.seek(0)
    assert read_record(stream) == {"protocolVersion": 1, "type": "hello", "sequence": 0}
    assert read_record(stream) is None


def test_framing_rejects_truncated_and_oversized_records() -> None:
    with pytest.raises(ProtocolError, match="truncated"):
        read_record(io.BytesIO(struct.pack(">I", 10) + b"{}"))
    with pytest.raises(ProtocolError, match="invalid record length"):
        read_record(io.BytesIO(struct.pack(">I", 0)))


def test_audio_validation_rejects_oversized_or_odd_pcm() -> None:
    common = {"sessionId": "11111111-1111-4111-8111-111111111111", "generation": 1}
    oversized = base64.b64encode(b"x" * (MAX_AUDIO_BYTES + 1)).decode()
    with pytest.raises(ProtocolError, match="INVALID_AUDIO_FRAME"):
        validate_command(envelope("audio", audioBase64=oversized, **common), Settings())
    odd = base64.b64encode(b"x").decode()
    with pytest.raises(ProtocolError, match="INVALID_AUDIO_FRAME"):
        validate_command(envelope("audio", audioBase64=odd, **common), Settings())


def test_start_validation_normalizes_session_id() -> None:
    command = validate_command(
        envelope("start", sessionId="11111111-1111-4111-8111-111111111111", generation=2, sampleRate=16000, channels=1,
                 format="pcm_s16le", language="en", mode="fast"),
        Settings(),
    )
    assert str(command["start"].session_id) == "11111111-1111-4111-8111-111111111111"


def test_rejects_extra_start_fields_and_non_uuid_session() -> None:
    with pytest.raises(ProtocolError, match="INVALID_COMMAND_SHAPE"):
        validate_command(envelope("start", sessionId="not-a-uuid", generation=2, sampleRate=16000,
                         channels=1, format="pcm_s16le", language="en", mode="fast", unexpected=True), Settings())
    with pytest.raises(ProtocolError, match="INVALID_SESSION_ID"):
        validate_command(envelope("start", sessionId="not-a-uuid", generation=2, sampleRate=16000,
                         channels=1, format="pcm_s16le", language="en", mode="fast"), Settings())


@pytest.mark.parametrize("message_type,fields", [
    ("hello", {}),
    ("shutdown", {}),
    ("stop", {"sessionId": "11111111-1111-4111-8111-111111111111", "generation": 1}),
    ("cancel", {"sessionId": "11111111-1111-4111-8111-111111111111", "generation": 1}),
])
def test_rejects_unknown_envelope_fields(message_type: str, fields: dict) -> None:
    with pytest.raises(ProtocolError, match="INVALID_COMMAND_SHAPE"):
        validate_command(envelope(message_type, unexpected=True, **fields), Settings())


def test_session_commands_require_canonical_uuid_and_bounded_counters() -> None:
    with pytest.raises(ProtocolError, match="INVALID_SESSION_ID"):
        validate_command(envelope("stop", sessionId="not-a-uuid", generation=1), Settings())
    with pytest.raises(ProtocolError, match="INVALID_GENERATION"):
        validate_command(envelope("stop", sessionId="11111111-1111-4111-8111-111111111111", generation=True), Settings())
    with pytest.raises(ProtocolError, match="INVALID_SEQUENCE"):
        validate_command({"protocolVersion": 1, "type": "hello", "sequence": 2**31}, Settings())
