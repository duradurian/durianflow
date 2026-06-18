from dataclasses import dataclass, field
from time import monotonic


@dataclass
class SessionMetrics:
    audio_seconds_received: float = 0.0
    partial_transcriptions: int = 0
    final_transcriptions: int = 0
    errors: int = 0
    started_at: float = field(default_factory=monotonic)

    @property
    def age_seconds(self) -> float:
        return monotonic() - self.started_at
