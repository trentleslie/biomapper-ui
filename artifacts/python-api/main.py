import logging
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from routes import health, map as map_router

logger = logging.getLogger("entity-linker")
logging.basicConfig(level=logging.INFO)

try:
    from importlib.metadata import version as _pkg_version
    biomapper_version = _pkg_version("biomapper")
except Exception as e:
    biomapper_version = f"unknown ({e})"
logger.info("biomapper version: %s", biomapper_version)

app = FastAPI(title="Entity Linker API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(map_router.router, prefix="/map")


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    errors = exc.errors()
    msg = errors[0]["msg"] if errors else "Validation error"
    return JSONResponse(status_code=400, content={"detail": msg})


@app.exception_handler(ValueError)
async def value_error_handler(request: Request, exc: ValueError) -> JSONResponse:
    return JSONResponse(status_code=400, content={"detail": str(exc)})
