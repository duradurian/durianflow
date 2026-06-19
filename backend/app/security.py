from __future__ import annotations

from ipaddress import ip_address
from urllib.parse import urlparse

from fastapi import WebSocket

from app.config import Settings


LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
LOCAL_ORIGINS = {"", "null", "file://"}


def _clean_host(host: str | None) -> str:
    value = str(host or "").strip().lower()
    if not value:
        return ""
    if value.startswith("[") and "]" in value:
        return value[1:value.index("]")]
    if ":" in value and value.count(":") == 1:
        return value.split(":", 1)[0]
    return value


def is_loopback_host(host: str | None) -> bool:
    clean = _clean_host(host)
    if clean in LOCAL_HOSTS:
        return True
    try:
        return ip_address(clean).is_loopback
    except ValueError:
        return False


def configured_allowed_origins(settings: Settings) -> set[str]:
    origins = set()
    for origin in settings.ALLOWED_ORIGINS.split(","):
        value = origin.strip()
        if not value:
            continue
        origins.add(value if value in LOCAL_ORIGINS else value.rstrip("/"))
    return origins


def is_valid_api_token(token: str | None, settings: Settings) -> bool:
    expected = str(settings.API_TOKEN or "")
    return bool(expected) and token == expected


def bearer_token(authorization: str | None) -> str | None:
    value = str(authorization or "").strip()
    if not value.lower().startswith("bearer "):
        return None
    return value[7:].strip() or None


def is_allowed_origin(origin: str | None, settings: Settings, *, allow_local_origins: bool = True) -> bool:
    raw = str(origin or "").strip()
    value = raw if raw == "file://" else raw.rstrip("/")
    if allow_local_origins and value in LOCAL_ORIGINS:
        return True

    allowed = configured_allowed_origins(settings)
    if value in allowed:
        return True

    parsed = urlparse(value)
    return parsed.scheme in {"http", "https", "ws", "wss"} and is_loopback_host(parsed.hostname)


def validate_runtime_security(settings: Settings) -> None:
    if not is_loopback_host(settings.HOST) and not settings.OPENFLOW_SERVER_MODE:
        raise RuntimeError(
            "Refusing to bind Openflow backend to a non-loopback host unless "
            "OPENFLOW_SERVER_MODE=true is set."
        )
    if settings.OPENFLOW_SERVER_MODE and (
        not settings.REQUIRE_API_TOKEN or not str(settings.API_TOKEN or "").strip()
    ):
        raise RuntimeError(
            "OPENFLOW_SERVER_MODE requires REQUIRE_API_TOKEN=true and a non-empty API_TOKEN."
        )


def validate_websocket_trust(websocket: WebSocket, settings: Settings) -> tuple[bool, str]:
    host = websocket.headers.get("host")
    if not settings.OPENFLOW_SERVER_MODE and host and not is_loopback_host(host):
        return False, "Host is not allowed in local desktop mode."

    origin = websocket.headers.get("origin")
    allow_local_origins = not settings.OPENFLOW_SERVER_MODE or is_loopback_host(host)
    if not is_allowed_origin(origin, settings, allow_local_origins=allow_local_origins):
        return False, "Origin is not allowed."

    return True, ""
