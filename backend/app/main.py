import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket

from app.config import Settings, get_settings
from app.logging_config import configure_logging
from app.schemas import AVAILABLE_MODELS, HealthResponse, ModelsResponse
from app.transcriber import WhisperTranscriber
from app.websocket import handle_transcription_socket

configure_logging()
logger = logging.getLogger(__name__)
settings = get_settings()
transcriber = WhisperTranscriber(settings.MODEL_NAME, settings.DEVICE, settings.COMPUTE_TYPE)
transcription_semaphore = asyncio.Semaphore(settings.MAX_CONCURRENT_TRANSCRIPTIONS)


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        await asyncio.to_thread(transcriber.load)
    except Exception:
        logger.exception("Model load failed; /health will report model_loaded=false")
    yield


app = FastAPI(title=settings.APP_NAME, lifespan=lifespan)


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        app=settings.APP_NAME,
        model_loaded=transcriber.model_loaded,
        model_name=settings.MODEL_NAME,
        device=settings.DEVICE,
        compute_type=settings.COMPUTE_TYPE,
    )


@app.get("/v1/models", response_model=ModelsResponse)
async def models() -> ModelsResponse:
    return ModelsResponse(default=settings.MODEL_NAME, available=AVAILABLE_MODELS)


@app.websocket("/v1/transcribe")
async def transcribe_ws(websocket: WebSocket) -> None:
    await handle_transcription_socket(websocket, settings, transcriber, transcription_semaphore)
