import asyncio
import logging
from contextlib import asynccontextmanager
from time import monotonic

from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket

from app.config import Settings, get_settings
from app.logging_config import configure_logging
from app.model_store import resolve_model_source
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
MODEL_LOAD_RETRY_SECONDS = 30.0


async def try_load_model() -> None:
    global model_load_error, model_load_retry_after
    try:
        await asyncio.to_thread(transcriber.load)
        model_load_error = None
        model_load_retry_after = 0.0
    except Exception:
        model_load_error = transcriber.load_error or "Model load failed"
        model_load_retry_after = monotonic() + MODEL_LOAD_RETRY_SECONDS
        logger.exception("Model load failed; /health will report model_loaded=false")


@asynccontextmanager
async def lifespan(app: FastAPI):
    validate_runtime_security(settings)
    await try_load_model()
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
    if not transcriber.model_loaded and model_load_error and monotonic() >= model_load_retry_after:
        try:
            resolve_model_source(settings)
        except Exception as exc:
            model_load_error = str(exc)
            model_load_retry_after = monotonic() + MODEL_LOAD_RETRY_SECONDS
        else:
            await try_load_model()

    return HealthResponse(
        status="ok" if transcriber.model_loaded else "degraded",
        app=settings.APP_NAME,
        model_loaded=transcriber.model_loaded,
        model_error=model_load_error,
        model_name=settings.MODEL_NAME,
        device=settings.DEVICE,
        compute_type=settings.COMPUTE_TYPE,
    )


@app.get("/v1/models", response_model=ModelsResponse, dependencies=[Depends(require_http_api_token)])
async def models() -> ModelsResponse:
    return ModelsResponse(default=settings.MODEL_NAME, available=AVAILABLE_MODELS)


@app.websocket("/v1/transcribe")
async def transcribe_ws(websocket: WebSocket) -> None:
    await handle_transcription_socket(websocket, settings, transcriber, transcription_semaphore)
