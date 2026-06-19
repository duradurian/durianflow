import asyncio
import logging
from contextlib import asynccontextmanager
from time import monotonic

from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket

from app.config import Settings, get_settings
from app.logging_config import configure_logging
from app.model_store import expected_model_path, resolve_model_source
from app.schemas import AVAILABLE_MODELS, HealthResponse, ModelsResponse
from app.security import bearer_token, is_valid_api_token, validate_runtime_security
from app.transcriber import WhisperTranscriber
from app.websocket import handle_transcription_socket

configure_logging()
logger = logging.getLogger(__name__)
settings = get_settings()
transcriber = WhisperTranscriber(settings)
transcription_semaphore = asyncio.Semaphore(settings.MAX_CONCURRENT_TRANSCRIPTIONS)
model_load_error: str | None = None
model_load_retry_after: float = 0.0
model_load_task: asyncio.Task | None = None


def model_load_retry_seconds() -> float:
    return max(0.0, float(settings.MODEL_LOAD_RETRY_SECONDS))


def model_retry_after_seconds() -> int | None:
    if transcriber.model_loaded or is_model_loading() or not model_load_error:
        return None
    remaining = int(max(0.0, model_load_retry_after - monotonic()))
    return remaining


def is_model_loading() -> bool:
    return model_load_task is not None and not model_load_task.done()


def start_model_load_task() -> None:
    global model_load_task
    if transcriber.model_loaded or is_model_loading():
        return
    model_load_task = asyncio.create_task(try_load_model())


async def try_load_model() -> None:
    global model_load_error, model_load_retry_after
    previous_error = model_load_error
    model_load_error = None
    try:
        await asyncio.to_thread(transcriber.load)
        model_load_error = None
        model_load_retry_after = 0.0
    except Exception:
        model_load_error = transcriber.load_error or "Model load failed"
        model_load_retry_after = monotonic() + model_load_retry_seconds()
        if model_load_error != previous_error:
            logger.exception("Model load failed; /health will report model_loaded=false")
        else:
            logger.warning("Model load still failing; /health will report model_loaded=false: %s", model_load_error)


@asynccontextmanager
async def lifespan(app: FastAPI):
    validate_runtime_security(settings)
    start_model_load_task()
    yield


app = FastAPI(title=settings.APP_NAME, lifespan=lifespan)


def require_http_api_token(
    x_api_token: str | None = Header(default=None),
    authorization: str | None = Header(default=None),
) -> None:
    if settings.REQUIRE_API_TOKEN and not (
        is_valid_api_token(x_api_token, settings)
        or is_valid_api_token(bearer_token(authorization), settings)
    ):
        raise HTTPException(status_code=401, detail="Unauthorized")


@app.get("/health", response_model=HealthResponse, dependencies=[Depends(require_http_api_token)])
async def health() -> HealthResponse:
    global model_load_error, model_load_retry_after
    if not transcriber.model_loaded and not is_model_loading():
        if model_load_error and monotonic() >= model_load_retry_after:
            try:
                resolve_model_source(settings)
            except Exception as exc:
                model_load_error = str(exc)
                model_load_retry_after = monotonic() + model_load_retry_seconds()
            else:
                start_model_load_task()
        elif not model_load_error:
            start_model_load_task()

    return HealthResponse(
        status="ok" if transcriber.model_loaded else "degraded",
        app=settings.APP_NAME,
        model_loaded=transcriber.model_loaded,
        model_loading=is_model_loading(),
        model_error=model_load_error,
        model_name=settings.MODEL_NAME,
        model_source=transcriber.model_source if transcriber.model_loaded else None,
        expected_model_path=str(expected_model_path(settings)),
        model_retry_after_seconds=model_retry_after_seconds(),
        device=settings.DEVICE,
        compute_type=settings.COMPUTE_TYPE,
        active_device=transcriber.active_device,
        active_compute_type=transcriber.active_compute_type,
    )


@app.get("/v1/models", response_model=ModelsResponse, dependencies=[Depends(require_http_api_token)])
async def models() -> ModelsResponse:
    return ModelsResponse(default=settings.MODEL_NAME, available=AVAILABLE_MODELS)


@app.websocket("/v1/transcribe")
async def transcribe_ws(websocket: WebSocket) -> None:
    await handle_transcription_socket(websocket, settings, transcriber, transcription_semaphore)
