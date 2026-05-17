import asyncio
import logging
import time
from typing import Any

from services.database import database

logger = logging.getLogger("entity-linker")

_TTL_SECONDS = 3600  # 1 hour
_PURGE_INTERVAL = 300  # run purge at most every 5 minutes


class Job:
    def __init__(self, job_id: str, total: int, env: str = "production",
                 user_id: str | None = None, config: Any = None,
                 ttl_seconds: int = _TTL_SECONDS):
        self.job_id = job_id
        self.status = "pending"
        self.completed = 0
        self.total = total
        self.error_count = 0
        self.error_message: str | None = None
        self.results: list[dict[str, Any]] = []
        self.created_at = time.time()
        self.env = env
        self.user_id = user_id
        self.config = config
        self.ttl_seconds = ttl_seconds

    def to_dict(self) -> dict[str, Any]:
        return {
            "jobId": self.job_id,
            "status": self.status,
            "completed": self.completed,
            "total": self.total,
            "errorCount": self.error_count,
            "errorMessage": self.error_message,
            "results": self.results,
            "env": self.env,
            "createdAt": self.created_at,
        }


class JobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = asyncio.Lock()
        self._last_purge = time.time()

    def _maybe_purge(self) -> None:
        now = time.time()
        if now - self._last_purge >= _PURGE_INTERVAL:
            self._last_purge = now
            self.purge_expired()

    async def create(self, job_id: str, total: int, env: str = "production",
                     user_id: str | None = None, config: Any = None,
                     ttl_seconds: int = _TTL_SECONDS) -> Job:
        self._maybe_purge()
        job = Job(job_id, total, env=env, user_id=user_id, config=config, ttl_seconds=ttl_seconds)
        self._jobs[job_id] = job
        try:
            await database.insert_job(
                job_id=job_id,
                user_id=user_id,
                status="pending",
                total=total,
                env=env,
                config=config,
            )
        except Exception:
            logger.exception("Failed to persist new job %s to database", job_id)
        return job

    def get(self, job_id: str) -> Job | None:
        self._maybe_purge()
        return self._jobs.get(job_id)

    def add_result(self, job_id: str, result: dict[str, Any]) -> None:
        job = self._jobs.get(job_id)
        if job is None:
            return
        job.results.append(result)
        job.completed += 1
        if result.get("error"):
            job.error_count += 1
        if job.status == "pending":
            job.status = "processing"

    async def complete(self, job_id: str) -> None:
        job = self._jobs.get(job_id)
        if job:
            job.status = "complete"
            try:
                await database.update_job(
                    job_id,
                    status="complete",
                    completed=job.completed,
                    error_count=job.error_count,
                    results=job.results,
                )
            except Exception:
                logger.exception("Failed to persist job completion %s to database", job_id)

    async def error(self, job_id: str, message: str) -> None:
        job = self._jobs.get(job_id)
        if job:
            job.status = "error"
            job.error_message = message
            try:
                await database.update_job(
                    job_id,
                    status="error",
                    error_message=message,
                )
            except Exception:
                logger.exception("Failed to persist job error %s to database", job_id)

    def purge_expired(self) -> int:
        now = time.time()
        expired = [jid for jid, j in self._jobs.items() if now - j.created_at > j.ttl_seconds]
        for jid in expired:
            del self._jobs[jid]
        return len(expired)


job_store = JobStore()
