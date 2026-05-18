from fastapi import APIRouter, Header, HTTPException

from models.schemas import JobDetail, JobListItem, JobUpdate  # type: ignore[attr-defined]
from services.database import database
from services.jobs import job_store

router = APIRouter()


@router.get("")
async def list_jobs(
    x_clerk_user_id: str | None = Header(None),
) -> list[JobListItem]:
    if x_clerk_user_id is None:
        raise HTTPException(status_code=400, detail="Missing x-clerk-user-id header")
    rows = await database.list_jobs(x_clerk_user_id)
    return [JobListItem(**row) for row in rows]


@router.get("/{job_id}")
async def get_job(
    job_id: str,
    x_clerk_user_id: str | None = Header(None),
) -> JobDetail:
    if x_clerk_user_id is None:
        raise HTTPException(status_code=400, detail="Missing x-clerk-user-id header")
    job = await database.get_job(job_id)
    if job is None or job.get("user_id") != x_clerk_user_id:
        raise HTTPException(status_code=404, detail="Job not found")
    return JobDetail(**job)


@router.patch("/{job_id}")
async def update_job(
    job_id: str,
    body: JobUpdate,
    x_clerk_user_id: str | None = Header(None),
) -> JobDetail:
    if x_clerk_user_id is None:
        raise HTTPException(status_code=400, detail="Missing x-clerk-user-id header")
    job = await database.get_job(job_id)
    if job is None or job.get("user_id") != x_clerk_user_id:
        raise HTTPException(status_code=404, detail="Job not found")
    updates = body.model_dump(exclude_unset=True)
    if updates:
        await database.update_job(job_id, **updates)
    updated = await database.get_job(job_id)
    if updated is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return JobDetail(**updated)


@router.delete("/{job_id}", status_code=204)
async def delete_job(
    job_id: str,
    x_clerk_user_id: str | None = Header(None),
) -> None:
    if x_clerk_user_id is None:
        raise HTTPException(status_code=400, detail="Missing x-clerk-user-id header")
    job = await database.get_job(job_id)
    if job is None or job.get("user_id") != x_clerk_user_id:
        raise HTTPException(status_code=404, detail="Job not found")
    await database.delete_job(job_id)
    job_store.evict(job_id)
