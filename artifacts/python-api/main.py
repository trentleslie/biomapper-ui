import logging
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from routes import health, map as map_router, demo as demo_router, discovery as discovery_router, feedback as feedback_router, flags as flags_router, jobs as jobs_router, benchmark as benchmark_router
from services.database import database
from services.feedback_store import feedback_store
from services.mapper import MapperService

logger = logging.getLogger("entity-linker")
logging.basicConfig(level=logging.INFO)

try:
    from importlib.metadata import version as _pkg_version
    biomapper_version = _pkg_version("biomapper")
except Exception as e:
    biomapper_version = f"unknown ({e})"
logger.info("biomapper version: %s", biomapper_version)

_resolved_base_url = MapperService._get_base_url()
logger.info("biomapper base_url: %s", _resolved_base_url or "default")


@asynccontextmanager
async def lifespan(app):
    await database.initialize()
    await database.recover_stale_jobs()
    await database.recover_stale_benchmark_runs()
    await feedback_store.init_db()
    yield
    await database.close()


app = FastAPI(title="Entity Linker API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(map_router.router, prefix="/map")
app.include_router(demo_router.router, prefix="/map")
app.include_router(discovery_router.router, prefix="/discovery")
app.include_router(feedback_router.router, prefix="/feedback")
app.include_router(flags_router.router, prefix="/flags")
app.include_router(jobs_router.router, prefix="/jobs")
app.include_router(benchmark_router.router, prefix="/benchmark")


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    errors = exc.errors()
    msg = errors[0]["msg"] if errors else "Validation error"
    return JSONResponse(status_code=400, content={"detail": msg})


@app.exception_handler(ValueError)
async def value_error_handler(request: Request, exc: ValueError) -> JSONResponse:
    return JSONResponse(status_code=400, content={"detail": str(exc)})
