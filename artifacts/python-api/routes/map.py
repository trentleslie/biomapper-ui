import asyncio
import json
import uuid
from typing import AsyncIterator

from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import ValidationError

from models.schemas import BatchRequest
from services.jobs import job_store
from services.mapper import MapperService

router = APIRouter()


@router.post("/batch")
async def start_batch(request: BatchRequest, background_tasks: BackgroundTasks) -> dict:
    job_id = str(uuid.uuid4())
    job_store.create(job_id, total=len(request.names))
    background_tasks.add_task(_run_mapping, job_id, request)
    return {"job_id": job_id}


@router.get("/stream/{job_id}")
async def stream_progress(job_id: str) -> StreamingResponse:
    job = job_store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")

    async def event_generator() -> AsyncIterator[str]:
        job_store.purge_expired()
        while True:
            job = job_store.get(job_id)
            if job is None:
                yield _sse_event("error", {"message": "Job not found"})
                break

            payload = job.to_dict()
            yield _sse_event("progress", payload)

            if job.status in ("complete", "error"):
                break

            await asyncio.sleep(0.5)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/result/{job_id}")
async def get_result(job_id: str) -> dict:
    job = job_store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status not in ("complete", "error"):
        raise HTTPException(status_code=202, detail="Job not yet complete")
    return job.to_dict()


async def _run_mapping(job_id: str, request: BatchRequest) -> None:
    mapper = MapperService()
    try:
        async for result in mapper.map_batch(request.names, request.config):
            job_store.add_result(job_id, result)
            if result.get("error_type") == "auth_failure":
                job_store.error(job_id, result.get("error", "Auth failure"))
                return
        job_store.complete(job_id)
    except Exception as e:
        job_store.error(job_id, str(e))


def _sse_event(event_name: str, data: dict) -> str:
    return f"event: {event_name}\ndata: {json.dumps(data)}\n\n"
