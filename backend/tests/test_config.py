import pytest
from pydantic import ValidationError

from app.config import Settings


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("SAMPLE_RATE", 48000),
        ("CHANNELS", 2),
        ("MAX_BUFFER_SECONDS", 0),
        ("MAX_SESSION_SECONDS", -1),
        ("MAX_CONCURRENT_TRANSCRIPTIONS", 0),
        ("ROLLING_WINDOW_SECONDS", 0),
        ("VAD_MIN_SILENCE_MS", -1),
    ],
)
def test_settings_reject_values_that_break_runtime_invariants(field: str, value: object) -> None:
    with pytest.raises(ValidationError):
        Settings(_env_file=None, **{field: value})


def test_cross_platform_backend_defaults_to_auto_and_accepts_mlx() -> None:
    assert Settings(_env_file=None).DEVICE == "auto"
    assert Settings(_env_file=None).COMPUTE_TYPE == "auto"
    assert Settings(_env_file=None, DEVICE="mlx").DEVICE == "mlx"
