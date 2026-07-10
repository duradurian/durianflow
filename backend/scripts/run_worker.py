"""Development entry point for the local stdio transcription worker."""

from pathlib import Path
import sys

# Running this file directly sets sys.path[0] to ``scripts``.  Add the backend
# root so the ``app`` package resolves without relying on the caller's cwd.
BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.worker import main  # noqa: E402


if __name__ == "__main__":
    main()
