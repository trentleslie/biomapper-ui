"""The harmonization job backend: the package's restart-safe runner, or a recorded replay.

Routes talk to :func:`get_backend`, which returns whatever :func:`make_backend` entered in the
app lifespan. Both backends return real ``biomapper.jobs.HarmonizeStatus`` objects and raise
``biomapper.jobs.JobError`` with a message written for the end user.
"""
from __future__ import annotations

import os
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncContextManager, Protocol

from biomapper.jobs import CohortSpec, HarmonizeJobs, HarmonizeStatus

from services import harmonize_storage
from services.mapper import MapperService

REPLAY_DIR_ENV = "BIOMAPPER_HARMONIZE_REPLAY_DIR"
REPLAY_PACE_ENV = "BIOMAPPER_HARMONIZE_REPLAY_PACE"


class HarmonizeBackend(Protocol):
    async def submit_cohorts(self, a: CohortSpec, b: CohortSpec, *, entity: str, category: str | None = None, output_dir: Path | None = None) -> HarmonizeStatus: ...
    async def submit_many(self, cohorts: list[CohortSpec], *, entity: str, category: str | None = None, output_dir: Path | None = None, store_dir: Path | None = None, remap_all: bool = False) -> HarmonizeStatus: ...
    async def status(self, job_id: str) -> HarmonizeStatus: ...
    async def list_jobs(self) -> list[HarmonizeStatus]: ...
    async def resume(self, job_id: str) -> HarmonizeStatus: ...
    async def cancel(self, job_id: str) -> HarmonizeStatus: ...
    def load_report(self, job_id: str) -> dict: ...
    def review_items(self, job_id: str, *, kind: str | None = None, offset: int = 0, limit: int | None = None): ...
    def review_item(self, job_id: str, ref: str): ...


_backend: HarmonizeBackend | None = None


def _api_key() -> str | None:
    # The mapper's BioMapperClient reads BIOMAPPER_API_KEY itself. HarmonizeJobs does not: it
    # goes keyless unless given a key, so pass the same one explicitly.
    value = (os.environ.get("BIOMAPPER_API_KEY") or "").strip()
    return value or None


def real_backend(
    home: Path,
    roots: Sequence[Path],
    *,
    base_url: str | None,
    api_key: str | None,
    kestrel_url: str | None = None,
    **limits: Any,
) -> HarmonizeJobs:
    """A ``HarmonizeJobs`` over ``home`` and ``roots`` (created if missing)."""
    Path(home).mkdir(parents=True, exist_ok=True)
    for root in roots:
        Path(root).mkdir(parents=True, exist_ok=True)
    return HarmonizeJobs(home, list(roots), base_url=base_url, api_key=api_key,
                         kestrel_url=kestrel_url, **limits)


def _select() -> AsyncContextManager[Any]:
    replay_dir = (os.environ.get(REPLAY_DIR_ENV) or "").strip()
    if replay_dir:
        from services.harmonize_replay import ReplayBackend

        pace = float((os.environ.get(REPLAY_PACE_ENV) or "0").strip() or 0)
        return ReplayBackend(Path(replay_dir), seconds_per_update=pace)
    return real_backend(
        harmonize_storage.jobs_home(),
        [harmonize_storage.runs_root()],
        base_url=MapperService._get_base_url(),
        api_key=_api_key(),
    )


@asynccontextmanager
async def make_backend() -> AsyncIterator[HarmonizeBackend]:
    """Enter the backend for the life of the app and register it for :func:`get_backend`.

    ``ReplayBackend`` when ``BIOMAPPER_HARMONIZE_REPLAY_DIR`` is set, else ``HarmonizeJobs`` on
    ``jobs_home()`` with ``runs_root()`` as its only root, pointed at the same deployment and
    key the mapper uses. Enter it once per process, in one task (the lifespan).
    """
    global _backend
    async with _select() as backend:
        _backend = backend
        try:
            yield backend
        finally:
            _backend = None


def get_backend() -> HarmonizeBackend:
    """The backend entered in the lifespan."""
    if _backend is None:
        raise RuntimeError("The harmonization backend is not running.")
    return _backend
