"""Replay a recorded harmonization run without calling BioMapper.

A recordings directory holds ``two_cohort/`` (for ``submit_cohorts``) and ``many_cohort/`` (for
``submit_many``), each with:

* ``status.json``: a finished ``HarmonizeStatus`` dump (``status.model_dump(mode="json")``).
* ``progress.jsonl``: one ``HarmonizeProgress.to_dict()`` per line, in the order they arrived.
* ``report.json``: the finished report (``HarmonizeJobs.load_report``).
* ``review_items.json``: ``{"skipped_no_node": int, "items": [ReviewItemSummary dump, ...],
  "details": {ref: ReviewItemDetail dump}}``, every item of the finished job.

Each submit starts a new job that replays ``progress.jsonl`` at ``seconds_per_update`` and then
ends in the recorded finished status. Jobs replay one at a time, like the real runner.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import shutil
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from types import TracebackType
from typing import Any

from biomapper.jobs import (
    FINISHED_STATES,
    CohortSpec,
    HarmonizeStatus,
    JobError,
    ReviewItemDetail,
    ReviewItemsPage,
    ReviewItemSummary,
    load_report,
)

REPORT_FILENAME = "report.json"
REVIEW_PAGE_DEFAULT = 25
REVIEW_PAGE_MAX = 50
_RECORDING_OF = {"harmonize_cohorts": "two_cohort", "harmonize_many": "many_cohort"}
_RESUMABLE = frozenset({"stalled", "paused", "expired", "cancelled"})


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class _Recording:
    directory: Path
    finished: HarmonizeStatus
    progress: list[dict[str, Any]]
    review: dict[str, Any]

    @classmethod
    def load(cls, directory: Path) -> _Recording:
        try:
            finished = HarmonizeStatus.model_validate_json(
                (directory / "status.json").read_text(encoding="utf-8"))
            lines = (directory / "progress.jsonl").read_text(encoding="utf-8").splitlines()
            progress = [json.loads(ln) for ln in lines if ln.strip()]
            review = json.loads((directory / "review_items.json").read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise JobError(
                f"The replay recording in {directory} cannot be read ({type(exc).__name__})."
            ) from None
        problem = None
        if finished.state not in FINISHED_STATES:
            problem = f"status.json is {finished.state!r}, not a finished status"
        elif not all(isinstance(p, dict) for p in progress):
            problem = "progress.jsonl must hold one JSON object per line"
        elif not (isinstance(review, dict) and isinstance(review.get("items"), list)
                  and isinstance(review.get("details"), dict)):
            problem = "review_items.json must be an object with an 'items' list and a 'details' object"
        elif not (directory / REPORT_FILENAME).is_file():
            problem = f"{REPORT_FILENAME} is missing"
        if problem is not None:
            raise JobError(f"The replay recording in {directory} is not usable: {problem}.")
        return cls(directory, finished, progress, review)


@dataclass
class _ReplayJob:
    recording: _Recording
    status: HarmonizeStatus
    report_dir: Path
    sent: int = 0
    task: asyncio.Task[None] | None = field(default=None, repr=False)


class ReplayBackend:
    """A ``HarmonizeBackend`` that replays recordings. Use as an async context manager."""

    def __init__(self, recordings: Path, *, seconds_per_update: float = 0.0) -> None:
        self._recordings = Path(recordings)
        self._pace = max(float(seconds_per_update), 0.0)
        self._jobs: dict[str, _ReplayJob] = {}
        self._worker = asyncio.Lock()
        self._running = False

    async def __aenter__(self) -> ReplayBackend:
        self._running = True
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self._running = False
        tasks = [j.task for j in self._jobs.values() if j.task is not None]
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task

    # -- submit ------------------------------------------------------------

    def _recording(self, kind: str) -> _Recording:
        return _Recording.load(self._recordings / _RECORDING_OF[kind])

    def _submit(self, kind: str, output_dir: Path | None) -> HarmonizeStatus:
        if not self._running:
            raise RuntimeError("ReplayBackend is not running; use it as `async with`.")
        recording = self._recording(kind)
        if output_dir is not None and (Path(output_dir) / REPORT_FILENAME).exists():
            raise JobError(f"{output_dir} already holds a report; choose an empty folder.")
        report_dir = Path(output_dir) if output_dir is not None else recording.directory
        now = _now()
        status = recording.finished.model_copy(update={
            "job_id": uuid.uuid4().hex[:12],
            "state": "queued",
            "reason": None,
            "stage": "queued",
            "output_dir": str(report_dir),
            "entities_mapped": 0,
            "rows_errored": 0,
            "eta_s": None,
            "created_utc": now,
            "updated_utc": now,
            "summary": None,
            "review_items": None,
            "progress": None,
        })
        job = _ReplayJob(recording=recording, status=status, report_dir=report_dir)
        self._jobs[status.job_id] = job
        self._start(job)
        return status

    async def submit_cohorts(
        self,
        a: CohortSpec,
        b: CohortSpec,
        *,
        entity: str,
        category: str | None = None,
        output_dir: Path | None = None,
    ) -> HarmonizeStatus:
        return self._submit("harmonize_cohorts", output_dir)

    async def submit_many(
        self,
        cohorts: list[CohortSpec],
        *,
        entity: str,
        category: str | None = None,
        output_dir: Path | None = None,
        store_dir: Path | None = None,
        remap_all: bool = False,
    ) -> HarmonizeStatus:
        return self._submit("harmonize_many", output_dir)

    # -- the replay ----------------------------------------------------------

    def _start(self, job: _ReplayJob) -> None:
        job.task = asyncio.create_task(self._replay(job))

    def _update(self, job: _ReplayJob, **changes: Any) -> None:
        job.status = job.status.model_copy(update={**changes, "updated_utc": _now()})

    async def _replay(self, job: _ReplayJob) -> None:
        try:
            await self._play(job)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — a broken replay must not hang as "running"
            self._update(job, state="failed",
                         reason=f"The replay could not finish ({type(exc).__name__}).")

    async def _play(self, job: _ReplayJob) -> None:
        async with self._worker:
            lines = job.recording.progress
            total = job.status.entities_total
            while job.sent < len(lines):
                await asyncio.sleep(self._pace)
                line = lines[job.sent]
                job.sent += 1
                # A job-wide estimate, short of the total until the job finishes.
                mapped = min(total * job.sent // (len(lines) + 1), max(total - 1, 0))
                self._update(job, state="running", stage="mapping", progress=line,
                             entities_mapped=mapped)
            await asyncio.sleep(self._pace)
            if job.report_dir != job.recording.directory:
                job.report_dir.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(job.recording.directory / REPORT_FILENAME,
                                job.report_dir / REPORT_FILENAME)
            finished = job.recording.finished
            self._update(
                job,
                state=finished.state,
                reason=finished.reason,
                stage=finished.stage,
                entities_mapped=finished.entities_mapped,
                rows_errored=finished.rows_errored,
                summary=finished.summary,
                review_items=finished.review_items,
                progress=lines[-1] if lines else finished.progress,
            )

    # -- status, resume, cancel ----------------------------------------------

    def _job(self, job_id: str) -> _ReplayJob:
        job = self._jobs.get(job_id)
        if job is None:
            raise JobError(f"No harmonize job {job_id!r}.")
        return job

    async def status(self, job_id: str) -> HarmonizeStatus:
        return self._job(job_id).status

    async def list_jobs(self) -> list[HarmonizeStatus]:
        return [j.status for j in self._jobs.values()]

    async def resume(self, job_id: str) -> HarmonizeStatus:
        job = self._job(job_id)
        if job.status.state in {"failed", "partial"}:
            raise JobError(f"Job {job_id} is {job.status.state}; submit it again instead.")
        if job.status.state in _RESUMABLE:
            self._update(job, state="queued", reason=None)
            self._start(job)
        return job.status

    async def cancel(self, job_id: str) -> HarmonizeStatus:
        job = self._job(job_id)
        if job.status.state not in {"queued", "running"}:
            return job.status
        if job.task is not None and not job.task.done():
            job.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await job.task
        self._update(job, state="cancelled",
                     reason="Cancelled. What was mapped is kept; resume continues it.")
        return job.status

    # -- results -------------------------------------------------------------

    def _finished(self, job_id: str, what: str) -> _ReplayJob:
        job = self._job(job_id)
        if job.status.state not in FINISHED_STATES:
            raise JobError(
                f"Job {job_id} is {job.status.state} (stage {job.status.stage}); its {what} "
                "available once it is complete."
            )
        return job

    def load_report(self, job_id: str) -> dict:
        job = self._finished(job_id, "report is")
        try:
            return load_report(job.report_dir)
        except (OSError, ValueError) as exc:
            raise JobError(
                f"Job {job_id} finished, but its report cannot be read ({type(exc).__name__})."
            ) from None

    def review_items(
        self,
        job_id: str,
        *,
        kind: str | None = None,
        offset: int = 0,
        limit: int | None = None,
    ) -> ReviewItemsPage:
        job = self._finished(job_id, "review items are")
        size = REVIEW_PAGE_DEFAULT if limit is None else limit
        if not 1 <= size <= REVIEW_PAGE_MAX:
            raise JobError(f"limit must be between 1 and {REVIEW_PAGE_MAX} (got {size}).")
        if offset < 0:
            raise JobError(f"offset must be 0 or more (got {offset}).")
        items = [ReviewItemSummary.model_validate(i) for i in job.recording.review["items"]]
        chosen = [i for i in items if kind is None or i.kind == kind]
        window = chosen[offset: offset + size]
        end = offset + len(window)
        return ReviewItemsPage(
            job_id=job_id,
            total=len(chosen),
            counts={"row": sum(i.kind == "row" for i in items),
                    "link": sum(i.kind == "link" for i in items)},
            skipped_no_node=int(job.recording.review.get("skipped_no_node", 0)),
            offset=offset,
            limit=size,
            next_offset=end if end < len(chosen) else None,
            items=window,
        )

    def review_item(self, job_id: str, ref: str) -> ReviewItemDetail:
        job = self._finished(job_id, "review items are")
        raw = job.recording.review.get("details", {}).get(ref)
        if raw is None:
            raise JobError(f"No review item {ref!r} in job {job_id}.")
        return ReviewItemDetail.model_validate({**raw, "job_id": job_id})
