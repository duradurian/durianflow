import pytest

from app.config import Settings
from app.websocket import validate_start_message


def test_valid_start_message() -> None:
    settings = Settings()
    msg = validate_start_message(
        {
            "type": "start",
            "session_id": "abc",
            "sample_rate": 16000,
            "channels": 1,
            "format": "pcm_s16le",
            "language": "en",
            "mode": "fast",
        },
        settings,
    )
    assert msg.session_id == "abc"


def test_invalid_audio_format() -> None:
    settings = Settings()
    with pytest.raises(ValueError):
        validate_start_message(
            {
                "type": "start",
                "session_id": "abc",
                "sample_rate": 48000,
                "channels": 2,
                "format": "pcm_s16le",
                "language": "en",
                "mode": "fast",
            },
            settings,
        )


def test_invalid_message_shape() -> None:
    settings = Settings()
    with pytest.raises(Exception):
        validate_start_message({"type": "start"}, settings)
