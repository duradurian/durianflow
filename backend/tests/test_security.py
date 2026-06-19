import asyncio

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import main as main_module
from app.config import Settings
from app.main import app, health, require_http_api_token, settings as app_settings
from app.security import is_allowed_origin, is_loopback_host, validate_runtime_security


def test_loopback_hosts_are_allowed() -> None:
    assert is_loopback_host("127.0.0.1:8000")
    assert is_loopback_host("localhost")
    assert is_loopback_host("[::1]:8000")


def test_non_loopback_requires_server_mode() -> None:
    settings = Settings(HOST="0.0.0.0", OPENFLOW_SERVER_MODE=False)
    with pytest.raises(RuntimeError, match="OPENFLOW_SERVER_MODE"):
        validate_runtime_security(settings)


def test_server_mode_requires_token() -> None:
    settings = Settings(HOST="0.0.0.0", OPENFLOW_SERVER_MODE=True, REQUIRE_API_TOKEN=False)
    with pytest.raises(RuntimeError, match="API_TOKEN"):
        validate_runtime_security(settings)


def test_server_mode_with_token_is_allowed() -> None:
    settings = Settings(
        HOST="0.0.0.0",
        OPENFLOW_SERVER_MODE=True,
        REQUIRE_API_TOKEN=True,
        API_TOKEN="secret",
    )
    validate_runtime_security(settings)


def test_local_origins_are_allowed_by_default() -> None:
    settings = Settings(_env_file=None)
    assert is_allowed_origin("file://", settings)
    assert is_allowed_origin("null", settings)
    assert is_allowed_origin("http://127.0.0.1:3000", settings)
    assert is_allowed_origin("http://localhost:3000", settings)


def test_remote_origin_requires_allowlist() -> None:
    settings = Settings(_env_file=None)
    assert not is_allowed_origin("https://example.com", settings)
    settings = Settings(_env_file=None, ALLOWED_ORIGINS="https://example.com")
    assert is_allowed_origin("https://example.com", settings)


def test_server_mode_does_not_allow_local_origins_by_default() -> None:
    settings = Settings(_env_file=None, ALLOWED_ORIGINS="")
    assert not is_allowed_origin("file://", settings, allow_local_origins=False)
    assert not is_allowed_origin("null", settings, allow_local_origins=False)


def test_server_mode_allows_explicit_file_origin() -> None:
    settings = Settings(_env_file=None, ALLOWED_ORIGINS="file://,null")
    assert is_allowed_origin("file://", settings, allow_local_origins=False)
    assert is_allowed_origin("null", settings, allow_local_origins=False)


def test_http_token_dependency_rejects_missing_token(monkeypatch) -> None:
    monkeypatch.setattr(app_settings, "REQUIRE_API_TOKEN", True)
    monkeypatch.setattr(app_settings, "API_TOKEN", "secret")
    with pytest.raises(HTTPException):
        require_http_api_token()


def test_http_token_dependency_accepts_header_token(monkeypatch) -> None:
    monkeypatch.setattr(app_settings, "REQUIRE_API_TOKEN", True)
    monkeypatch.setattr(app_settings, "API_TOKEN", "secret")
    require_http_api_token(x_api_token="secret")


def test_http_token_dependency_accepts_bearer_token(monkeypatch) -> None:
    monkeypatch.setattr(app_settings, "REQUIRE_API_TOKEN", True)
    monkeypatch.setattr(app_settings, "API_TOKEN", "secret")
    require_http_api_token(authorization="Bearer secret")


def test_models_endpoint_requires_token_when_enabled(monkeypatch) -> None:
    monkeypatch.setattr(app_settings, "REQUIRE_API_TOKEN", True)
    monkeypatch.setattr(app_settings, "API_TOKEN", "secret")
    client = TestClient(app)

    assert client.get("/v1/models").status_code == 401
    assert client.get("/v1/models", headers={"x-api-token": "secret"}).status_code == 200


def test_health_does_not_retry_model_load_before_cooldown(monkeypatch) -> None:
    def fail_if_called(_settings):
        raise AssertionError("health should not retry model load before cooldown")

    monkeypatch.setattr(main_module.transcriber, "_model", None)
    monkeypatch.setattr(main_module, "model_load_error", "previous failure")
    monkeypatch.setattr(main_module, "model_load_retry_after", main_module.monotonic() + 60)
    monkeypatch.setattr(main_module, "resolve_model_source", fail_if_called)

    response = asyncio.run(health())
    assert response.status == "degraded"
    assert response.model_error == "previous failure"


def test_health_reports_model_load_diagnostics(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(app_settings, "MODELS_DIR", str(tmp_path))
    monkeypatch.setattr(app_settings, "MODEL_NAME", "missing-model")
    monkeypatch.setattr(app_settings, "MODEL_PATH", None)
    monkeypatch.setattr(main_module.transcriber, "_model", None)
    monkeypatch.setattr(main_module, "model_load_error", "previous failure")
    monkeypatch.setattr(main_module, "model_load_retry_after", main_module.monotonic() + 60)

    response = asyncio.run(health())
    assert response.status == "degraded"
    assert response.expected_model_path is not None
    assert response.expected_model_path.endswith("missing-model")
    assert response.model_retry_after_seconds is not None


def test_health_retry_uses_configured_cooldown(monkeypatch) -> None:
    def source_is_available(_settings):
        return ("tiny", False)

    async def fail_load():
        main_module.model_load_error = "retry failed"
        main_module.model_load_retry_after = main_module.monotonic() + main_module.model_load_retry_seconds()

    monkeypatch.setattr(app_settings, "MODEL_LOAD_RETRY_SECONDS", 7)
    monkeypatch.setattr(main_module.transcriber, "_model", None)
    monkeypatch.setattr(main_module, "model_load_error", "previous failure")
    monkeypatch.setattr(main_module, "model_load_retry_after", main_module.monotonic() - 1)
    monkeypatch.setattr(main_module, "resolve_model_source", source_is_available)
    monkeypatch.setattr(main_module, "try_load_model", fail_load)

    response = asyncio.run(health())
    assert response.status == "degraded"
    assert response.model_error == "retry failed"
    assert response.model_retry_after_seconds is not None
    assert response.model_retry_after_seconds <= 7
