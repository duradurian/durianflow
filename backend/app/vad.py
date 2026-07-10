from dataclasses import dataclass

import numpy as np


@dataclass
class VadResult:
    is_speech: bool
    speech_started: bool
    speech_ended: bool


class EnergyVad:
    def __init__(
        self,
        sample_rate: int,
        threshold: float = 0.01,
        min_speech_ms: int = 120,
        min_silence_ms: int = 600,
    ) -> None:
        self.sample_rate = sample_rate
        self.threshold = threshold
        self.min_speech_samples = int(sample_rate * min_speech_ms / 1000)
        self.min_silence_samples = int(sample_rate * min_silence_ms / 1000)
        self.in_speech = False
        self.speech_candidate_samples = 0
        self.silence_samples = 0

    def process(self, audio_frame: np.ndarray) -> VadResult:
        if len(audio_frame) == 0:
            return VadResult(False, False, False)

        rms = float(np.sqrt(np.mean(np.square(audio_frame, dtype=np.float32))))
        frame_is_speech = rms >= self.threshold
        speech_started = False
        speech_ended = False

        if frame_is_speech:
            self.speech_candidate_samples += len(audio_frame)
            self.silence_samples = 0
            if not self.in_speech and self.speech_candidate_samples >= self.min_speech_samples:
                self.in_speech = True
                speech_started = True
        else:
            self.speech_candidate_samples = 0
            if self.in_speech:
                self.silence_samples += len(audio_frame)
                if self.silence_samples >= self.min_silence_samples:
                    self.in_speech = False
                    self.silence_samples = 0
                    speech_ended = True

        # ``is_speech`` describes this frame, while ``in_speech`` retains the
        # hysteresis state used to decide when an utterance has ended.  Keeping
        # those concepts separate lets callers apply a bounded trailing pad
        # instead of buffering the entire silence window.
        return VadResult(frame_is_speech, speech_started, speech_ended)
