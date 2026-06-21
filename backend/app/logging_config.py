import logging
import os
import re
from logging.handlers import RotatingFileHandler
from pathlib import Path


class RedactingFormatter(logging.Formatter):
    """Keep local logs useful without retaining transcripts, paths, or tokens."""

    _path = re.compile(r"(?:[A-Za-z]:)?[\\/][^\s\]\[\"']+")
    _secret = re.compile(r"(?i)(token|api[_-]?key|authorization)\s*[=:]\s*[^\s,]+")
    _maximum_message_length = 4096

    def format(self, record: logging.LogRecord) -> str:
        message = super().format(record)
        message = self._secret.sub(r"\1=[REDACTED]", message)
        message = self._path.sub("[PATH]", message)
        return message[: self._maximum_message_length]


def default_log_dir() -> Path:
    base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / ".local" / "share")
    return base / "Durianflow" / "logs"


def configure_logging(log_dir: Path | None = None) -> None:
    """Configure bounded logs; callers may pass an app-private log directory."""
    formatter = RedactingFormatter("%(asctime)s %(levelname)s [%(name)s] %(message)s")
    handlers: list[logging.Handler] = [logging.StreamHandler()]
    log_dir = log_dir or default_log_dir()
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        handlers.append(RotatingFileHandler(log_dir / "durianflow.log", maxBytes=1_000_000, backupCount=3, encoding="utf-8"))
    except OSError:
        # Worker stdout is protocol-only.  Retain bounded stderr logging when a
        # locked-down environment does not permit a per-user log directory.
        pass
    for handler in handlers:
        handler.setFormatter(formatter)
    logging.basicConfig(
        level=logging.INFO,
        handlers=handlers,
        force=True,
    )
