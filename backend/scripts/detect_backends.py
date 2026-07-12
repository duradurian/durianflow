"""Print model-free MLX, CUDA, and CPU capability information."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.backends import detect_backend_capabilities, select_backend  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Detect Durianflow inference backends.")
    parser.add_argument("--json", action="store_true", help="Print one JSON object.")
    args = parser.parse_args()

    capabilities = detect_backend_capabilities()
    try:
        selected = select_backend("auto", capabilities)
    except RuntimeError:
        selected = None
    payload = {
        "selected": selected,
        "capabilities": [capability.as_dict() for capability in capabilities],
    }
    if args.json:
        print(json.dumps(payload, separators=(",", ":")))
        return
    print(f"Automatic selection: {selected or 'unavailable'}")
    for capability in capabilities:
        state = "available" if capability.available else "unavailable"
        detail = f" — {capability.reason}" if capability.reason else ""
        print(f"{capability.name}: {state} ({capability.device}, {capability.compute_type}){detail}")


if __name__ == "__main__":
    main()
