import asyncio
import csv
import uuid
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks
from fastapi.responses import JSONResponse

from models.schemas import BatchRequest, MappingConfig
from services.env_routing import resolve_env_base_url
from services.jobs import job_store
from services.mapper import MapperService

router = APIRouter()

# --- Demo dataset: read and validate at import time ---

DEMO_NAME_COLUMN = "compound_name"
DEMO_CSV_PATH = Path(__file__).resolve().parent.parent / "data" / "demo_dataset.csv"
DEMO_TTL_SECONDS = 600  # 10 minutes

_demo_names: list[str] = []

try:
    with open(DEMO_CSV_PATH, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        if DEMO_NAME_COLUMN not in (reader.fieldnames or []):
            raise RuntimeError(
                f"Demo CSV missing required column '{DEMO_NAME_COLUMN}'. "
                f"Found columns: {reader.fieldnames}"
            )
        seen: set[str] = set()
        for row in reader:
            name = row[DEMO_NAME_COLUMN].strip()
            if name and name not in seen:
                _demo_names.append(name)
                seen.add(name)
except FileNotFoundError:
    raise RuntimeError(
        f"Demo dataset not found at {DEMO_CSV_PATH}. "
        "Cannot start server without demo data."
    )

if not _demo_names:
    raise RuntimeError("Demo dataset contains no valid names.")

# --- Concurrency cap ---

MAX_ACTIVE_DEMO_JOBS = 3
_demo_semaphore: asyncio.Semaphore | None = None


def _get_semaphore() -> asyncio.Semaphore:
    global _demo_semaphore
    if _demo_semaphore is None:
        _demo_semaphore = asyncio.Semaphore(MAX_ACTIVE_DEMO_JOBS)
    return _demo_semaphore


@router.post("/demo")
async def start_demo(background_tasks: BackgroundTasks) -> dict | JSONResponse:
    sem = _get_semaphore()
    if sem.locked():
        return JSONResponse(
            status_code=429,
            content={"detail": "Demo is busy. Please try again in a moment."},
            headers={"Retry-After": "30"},
        )

    await sem.acquire()

    job_id = str(uuid.uuid4())
    job_store.create(job_id, total=len(_demo_names), env="production", ttl_seconds=DEMO_TTL_SECONDS)

    background_tasks.add_task(_run_demo_mapping, job_id)
    return {"job_id": job_id}


async def _run_demo_mapping(job_id: str) -> None:
    """Run the demo mapping job, releasing the semaphore on completion."""
    try:
        _, base_url = resolve_env_base_url(None)  # production default
        request = BatchRequest(names=_demo_names, config=MappingConfig())
        mapper = MapperService(base_url_override=base_url)
        async for result in mapper.map_batch(request.names, request.config):
            job_store.add_result(job_id, result)
            if result.get("error_type") in ("auth_failure", "config_error"):
                job_store.error(job_id, result.get("error", "Fatal mapping error"))
                return
        job_store.complete(job_id)
    except Exception as e:
        job_store.error(job_id, str(e))
    finally:
        _get_semaphore().release()
