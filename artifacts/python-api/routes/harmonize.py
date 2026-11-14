"""Cohort harmonization runs: uploads, submit, run status, report and review items.

Every route takes the ``x-clerk-user-id`` header (400 when missing). A run belongs to the user
who started it; any other user gets 404 for it, on every route.

A run is one upload directory under ``harmonize_storage.runs_root()`` (its inputs, its own
``out/`` and, for many-cohort runs, its own ``store/``) plus one ``harmonize_runs`` row that
ties the package's job id to the user. A submit that fails leaves neither behind.

JSON is camelCase like the rest of the API. Run status is the package's
``HarmonizeStatus.model_dump(mode="json")`` with its keys camelCased (nested ``cohorts``,
``owner``, ``reviewItems`` and ``progress`` included) plus this app's ``kind``, ``labels``,
``entity`` and ``createdAt``. ``summary`` is the package's free-form block and passes through
as written, because its keys include cohort labels and arm names.

``JobError`` messages are written for end users and are passed through: 400, except the
runner's unfinished-jobs cap (409) and results asked for before the run finished (409).
"""
from __future__ import annotations

import csv
import dataclasses
import json
import logging
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from biomapper.jobs import FINISHED_STATES, CohortSpec, HarmonizeStatus, JobError
from biomapper.mcp.config import ServerConfig
from fastapi import APIRouter, File, Form, Header, HTTPException, Query, UploadFile
from pydantic import BaseModel, ConfigDict, ValidationError
from pydantic.alias_generators import to_camel

from services.database import database
from services.harmonize_backend import HarmonizeBackend, get_backend
from services.harmonize_storage import (
    MAX_COHORT_BYTES,
    CohortFileError,
    new_run_dir,
    read_header,
    remove_run_dir,
    save_cohort_file,
)

logger = logging.getLogger("entity-linker")

router = APIRouter()

KIND_TWO = "harmonize_cohorts"
KIND_MANY = "harmonize_many"
EXAMPLES_DIR = Path(__file__).resolve().parent.parent / "data" / "harmonize_examples"
# The runner's own per-job cohort cap, read from the package rather than restated. The route
# checks it before saving anything because a rejected upload should leave no files behind.
MAX_COHORTS: int = next(
    f.default for f in dataclasses.fields(ServerConfig) if f.name == "harmonize_max_cohorts"
)


# ---------------------------------------------------------------------------
# Request bodies
# ---------------------------------------------------------------------------


class _CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class CohortInput(_CamelModel):
    label: str
    name_column: str
    key_column: str | None = None
    vocabularies: dict[str, list[str]] = {}

    def columns(self) -> list[str]:
        cols = [self.name_column]
        if self.key_column:
            cols.append(self.key_column)
        for vocab_cols in self.vocabularies.values():
            cols.extend(vocab_cols)
        return cols

    def to_spec(self, path: Path) -> CohortSpec:
        return CohortSpec(label=self.label, path=str(path), name_column=self.name_column,
                          key_column=self.key_column, vocabularies=self.vocabularies)


class CohortsSpec(_CamelModel):
    entity: str
    category: str | None = None
    a: CohortInput
    b: CohortInput


class ManySpec(_CamelModel):
    entity: str
    category: str | None = None
    remap_all: bool = False
    cohorts: list[CohortInput]


class ExampleRequest(_CamelModel):
    kind: Literal["two_cohort"]


# ---------------------------------------------------------------------------
# Helpers: auth, ownership, errors, JSON shape
# ---------------------------------------------------------------------------


def _require_user(x_clerk_user_id: str | None) -> str:
    if x_clerk_user_id is None:
        raise HTTPException(status_code=400, detail="Missing x-clerk-user-id header")
    return x_clerk_user_id


async def _owned_run(job_id: str, user_id: str) -> dict[str, Any]:
    run = await database.get_harmonize_run(job_id)
    if run is None or run["user_id"] != user_id:
        raise HTTPException(status_code=404, detail="Run not found")
    return run


# biomapper 1.9.0 raises a plain JobError for its unfinished-jobs cap (no subclass, attribute
# or code), so the message is the only thing that tells it apart. Match the two fixed parts of
# that one sentence: "... unfinished harmonize job(s) (limit N) ...".
_QUEUE_FULL = re.compile(r"unfinished harmonize job\(s\) \(limit \d+\)")


def _is_queue_full(exc: JobError) -> bool:
    return _QUEUE_FULL.search(str(exc)) is not None


def _job_error(exc: JobError) -> HTTPException:
    return HTTPException(status_code=409 if _is_queue_full(exc) else 400, detail=str(exc))


_SNAKE_PART = re.compile(r"_([a-z0-9])")
# Values under these keys are maps keyed by data (cohort labels, arm names, vocabularies,
# certificate states, item kinds), not by field names, so their keys are kept as written.
_DATA_KEYED = frozenset({"summary", "counts", "identifiers", "certificate_states", "vocabularies"})


def _camel_key(key: str) -> str:
    return _SNAKE_PART.sub(lambda m: m.group(1).upper(), key)


def camelize(value: Any) -> Any:
    """Camel-case the field names of a package model dump, leaving data-keyed maps alone."""
    if isinstance(value, dict):
        return {_camel_key(k): (v if k in _DATA_KEYED else camelize(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [camelize(v) for v in value]
    return value


def _run_json(status: HarmonizeStatus, run: dict[str, Any]) -> dict[str, Any]:
    out = camelize(status.model_dump(mode="json"))
    out.update(kind=run["kind"], labels=run["labels"], entity=run["entity"],
               createdAt=run["created_at"])
    return out


async def _status_json(backend: HarmonizeBackend, run: dict[str, Any]) -> dict[str, Any]:
    try:
        status = await backend.status(run["job_id"])
    except JobError as exc:
        raise _job_error(exc) from None
    return _run_json(status, run)


async def _finished_or_409(backend: HarmonizeBackend, job_id: str, exc: JobError) -> HTTPException:
    """The HTTP error for a JobError from a results call: 409 while the run is not finished."""
    try:
        status = await backend.status(job_id)
    except JobError:
        return _job_error(exc)
    if status.state not in FINISHED_STATES:
        return HTTPException(status_code=409, detail=str(exc))
    return _job_error(exc)


def _now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


# ---------------------------------------------------------------------------
# Upload checks and submit
# ---------------------------------------------------------------------------


def _parse_spec(raw: str, model: type[_CamelModel]) -> Any:
    try:
        return model.model_validate_json(raw)
    except ValidationError as exc:
        err = exc.errors()[0]
        if err["type"] == "json_invalid":
            raise HTTPException(status_code=400, detail="spec is not valid JSON.") from None
        where = ".".join(str(p) for p in err["loc"])
        msg = f"Invalid spec: {where}: {err['msg']}" if where else f"Invalid spec: {err['msg']}"
        raise HTTPException(status_code=400, detail=msg) from None


def _check_distinct_labels(cohorts: list[CohortInput]) -> None:
    labels = [c.label for c in cohorts]
    if len(set(labels)) != len(labels):
        raise HTTPException(status_code=400,
                            detail=f"Cohort labels must be distinct (got {', '.join(labels)}).")


async def _read_upload(upload: UploadFile) -> tuple[str, bytes]:
    # One byte over the limit is enough for save_cohort_file to refuse it with its own message.
    return upload.filename or "", await upload.read(MAX_COHORT_BYTES + 1)


def _check_columns(cohort: CohortInput, path: Path, filename: str) -> None:
    header = read_header(path)
    for col in cohort.columns():
        if col not in header:
            raise HTTPException(
                status_code=400,
                detail=f"Column '{col}' is not in file '{filename}'. "
                       f"Columns found: {', '.join(header)}.",
            )


async def _start_run(
    user_id: str,
    kind: str,
    entity: str,
    category: str | None,
    cohorts: list[tuple[CohortInput, str, bytes]],
    *,
    remap_all: bool = False,
) -> dict[str, Any]:
    """Save the files into a new run directory, submit, and record ownership.

    Any failure before the job is accepted removes the run directory and inserts no row.
    """
    upload_id, run_dir = new_run_dir()
    try:
        specs = []
        for cohort, filename, data in cohorts:
            path = save_cohort_file(run_dir, cohort.label, filename, data)
            _check_columns(cohort, path, filename)
            specs.append(cohort.to_spec(path))
        backend = get_backend()
        if kind == KIND_TWO:
            status = await backend.submit_cohorts(
                specs[0], specs[1], entity=entity, category=category, output_dir=run_dir / "out")
        else:
            status = await backend.submit_many(
                specs, entity=entity, category=category, output_dir=run_dir / "out",
                store_dir=run_dir / "store", remap_all=remap_all)
    except BaseException as exc:
        try:
            remove_run_dir(run_dir)
        except OSError:
            logger.exception("Could not remove run directory %s", run_dir)
        if isinstance(exc, CohortFileError):
            raise HTTPException(status_code=400, detail=str(exc)) from None
        if isinstance(exc, JobError):
            raise _job_error(exc) from None
        raise
    run = {"job_id": status.job_id, "user_id": user_id, "kind": kind,
           "labels": [c.label for c, _, _ in cohorts], "entity": entity,
           "upload_id": upload_id, "created_at": _now_utc()}
    await database.insert_harmonize_run(**run)
    return _run_json(status, run)


# ---------------------------------------------------------------------------
# Routes: inspect and submit
# ---------------------------------------------------------------------------


@router.post("/inspect")
async def inspect_file(
    file: UploadFile = File(...),
    x_clerk_user_id: str | None = Header(None),
) -> dict[str, Any]:
    """The file's column names and data row count, checked like a cohort upload."""
    _require_user(x_clerk_user_id)
    filename, data = await _read_upload(file)
    with tempfile.TemporaryDirectory() as tmp:
        try:
            path = save_cohort_file(Path(tmp), "inspect", filename, data)
        except CohortFileError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        columns = read_header(path)
        delimiter = "\t" if path.suffix == ".tsv" else ","
        with path.open(newline="", encoding="utf-8-sig") as fh:
            rows = sum(1 for row in csv.reader(fh, delimiter=delimiter) if row)
    return {"columns": columns, "rowCount": max(rows - 1, 0)}


@router.post("/cohorts")
async def submit_cohorts(
    file_a: UploadFile = File(..., alias="fileA"),
    file_b: UploadFile = File(..., alias="fileB"),
    spec: str = Form(...),
    x_clerk_user_id: str | None = Header(None),
) -> dict[str, Any]:
    user_id = _require_user(x_clerk_user_id)
    parsed: CohortsSpec = _parse_spec(spec, CohortsSpec)
    _check_distinct_labels([parsed.a, parsed.b])
    a_name, a_data = await _read_upload(file_a)
    b_name, b_data = await _read_upload(file_b)
    return await _start_run(user_id, KIND_TWO, parsed.entity, parsed.category,
                            [(parsed.a, a_name, a_data), (parsed.b, b_name, b_data)])


@router.post("/many")
async def submit_many(
    files: list[UploadFile] = File(...),
    spec: str = Form(...),
    x_clerk_user_id: str | None = Header(None),
) -> dict[str, Any]:
    user_id = _require_user(x_clerk_user_id)
    if not 2 <= len(files) <= MAX_COHORTS:
        raise HTTPException(
            status_code=400,
            detail=f"A many-cohort run takes 2 to {MAX_COHORTS} cohort files (got {len(files)}).",
        )
    parsed: ManySpec = _parse_spec(spec, ManySpec)
    if len(parsed.cohorts) != len(files):
        raise HTTPException(
            status_code=400,
            detail=f"The spec describes {len(parsed.cohorts)} cohorts but {len(files)} files "
                   "were uploaded. Give one cohort per file, in file order.",
        )
    _check_distinct_labels(parsed.cohorts)
    uploads = [(cohort, *await _read_upload(f)) for cohort, f in zip(parsed.cohorts, files)]
    return await _start_run(user_id, KIND_MANY, parsed.entity, parsed.category, uploads,
                            remap_all=parsed.remap_all)


@router.post("/example")
async def submit_example(
    body: ExampleRequest,
    x_clerk_user_id: str | None = Header(None),
) -> dict[str, Any]:
    """Start a run on the built-in example: ``<EXAMPLES_DIR>/<kind>/`` holds ``spec.json``
    (the ``/cohorts`` spec) and the cohort files ``a.tsv`` and ``b.tsv``."""
    user_id = _require_user(x_clerk_user_id)
    example = EXAMPLES_DIR / body.kind
    spec_path, files = example / "spec.json", [example / "a.tsv", example / "b.tsv"]
    if not all(p.is_file() for p in [spec_path, *files]):
        raise HTTPException(status_code=400, detail="The example dataset is not installed.")
    parsed: CohortsSpec = _parse_spec(spec_path.read_text(encoding="utf-8"), CohortsSpec)
    _check_distinct_labels([parsed.a, parsed.b])
    return await _start_run(
        user_id, KIND_TWO, parsed.entity, parsed.category,
        [(cohort, path.name, path.read_bytes()) for cohort, path in zip((parsed.a, parsed.b), files)],
    )


# ---------------------------------------------------------------------------
# Routes: runs
# ---------------------------------------------------------------------------


@router.get("/runs")
async def list_runs(x_clerk_user_id: str | None = Header(None)) -> list[dict[str, Any]]:
    """The caller's runs, newest first, each with its status.

    A run the job runner no longer knows (its job record is gone) is listed with state
    ``unknown`` and the runner's message as ``reason``, so it is not silently dropped.
    """
    user_id = _require_user(x_clerk_user_id)
    backend = get_backend()
    out = []
    for run in await database.list_harmonize_runs(user_id):
        try:
            out.append(_run_json(await backend.status(run["job_id"]), run))
        except JobError as exc:
            out.append({"jobId": run["job_id"], "state": "unknown", "reason": str(exc),
                        "kind": run["kind"], "labels": run["labels"], "entity": run["entity"],
                        "createdAt": run["created_at"]})
    return out


@router.get("/runs/{job_id}")
async def get_run(job_id: str, x_clerk_user_id: str | None = Header(None)) -> dict[str, Any]:
    run = await _owned_run(job_id, _require_user(x_clerk_user_id))
    return await _status_json(get_backend(), run)


@router.post("/runs/{job_id}/resume")
async def resume_run(job_id: str, x_clerk_user_id: str | None = Header(None)) -> dict[str, Any]:
    run = await _owned_run(job_id, _require_user(x_clerk_user_id))
    try:
        status = await get_backend().resume(job_id)
    except JobError as exc:
        raise _job_error(exc) from None
    return _run_json(status, run)


@router.post("/runs/{job_id}/cancel")
async def cancel_run(job_id: str, x_clerk_user_id: str | None = Header(None)) -> dict[str, Any]:
    run = await _owned_run(job_id, _require_user(x_clerk_user_id))
    try:
        status = await get_backend().cancel(job_id)
    except JobError as exc:
        raise _job_error(exc) from None
    return _run_json(status, run)


@router.get("/runs/{job_id}/report")
async def get_report(job_id: str, x_clerk_user_id: str | None = Header(None)) -> dict[str, Any]:
    """``report.json`` as the package wrote it (snake_case, ``schema_version: 1``)."""
    await _owned_run(job_id, _require_user(x_clerk_user_id))
    backend = get_backend()
    try:
        return backend.load_report(job_id)
    except JobError as exc:
        raise await _finished_or_409(backend, job_id, exc) from None


@router.get("/runs/{job_id}/review-items")
async def list_review_items(
    job_id: str,
    kind: Literal["row", "link"] | None = Query(None),
    offset: int = Query(0),
    limit: int | None = Query(None),
    x_clerk_user_id: str | None = Header(None),
) -> dict[str, Any]:
    await _owned_run(job_id, _require_user(x_clerk_user_id))
    backend = get_backend()
    try:
        page = backend.review_items(job_id, kind=kind, offset=offset, limit=limit)
    except JobError as exc:
        raise await _finished_or_409(backend, job_id, exc) from None
    return camelize(page.model_dump(mode="json"))


@router.get("/runs/{job_id}/review-items/{ref}")
async def get_review_item(
    job_id: str, ref: str, x_clerk_user_id: str | None = Header(None),
) -> dict[str, Any]:
    await _owned_run(job_id, _require_user(x_clerk_user_id))
    backend = get_backend()
    try:
        detail = backend.review_item(job_id, ref)
    except JobError as exc:
        raise await _finished_or_409(backend, job_id, exc) from None
    return camelize(detail.model_dump(mode="json"))
