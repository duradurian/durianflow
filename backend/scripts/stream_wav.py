import argparse
import asyncio
import json
import sys
import time
import uuid
from pathlib import Path

import soundfile as sf
from scipy.signal import resample_poly
import websockets

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.audio import ensure_mono, float32_to_pcm16  # noqa: E402


async def stream(path: Path, url: str, chunk_ms: int) -> None:
    audio, sample_rate = sf.read(path, dtype="float32")
    audio = ensure_mono(audio)
    if sample_rate != 16000:
        audio = resample_poly(audio, 16000, sample_rate).astype("float32")

    async with websockets.connect(url) as ws:
        await ws.send(
            json.dumps(
                {
                    "type": "start",
                    "session_id": str(uuid.uuid4()),
                    "sample_rate": 16000,
                    "channels": 1,
                    "format": "pcm_s16le",
                    "language": "en",
                    "mode": "fast",
                }
            )
        )
        print(await ws.recv())
        chunk_samples = int(16000 * chunk_ms / 1000)
        for offset in range(0, len(audio), chunk_samples):
            await ws.send(float32_to_pcm16(audio[offset : offset + chunk_samples]))
            start = time.monotonic()
            while True:
                try:
                    print(await asyncio.wait_for(ws.recv(), timeout=0.001))
                except asyncio.TimeoutError:
                    break
            await asyncio.sleep(max(0, chunk_ms / 1000 - (time.monotonic() - start)))
        await ws.send(json.dumps({"type": "stop"}))
        try:
            while True:
                print(await asyncio.wait_for(ws.recv(), timeout=2))
        except asyncio.TimeoutError:
            return


def main() -> None:
    parser = argparse.ArgumentParser(description="Stream a WAV file to the live transcription WebSocket.")
    parser.add_argument("path", type=Path)
    parser.add_argument("--url", default="ws://localhost:8000/v1/transcribe")
    parser.add_argument("--chunk-ms", type=int, default=100)
    args = parser.parse_args()
    asyncio.run(stream(args.path, args.url, args.chunk_ms))


if __name__ == "__main__":
    main()
