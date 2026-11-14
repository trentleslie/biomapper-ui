"""Cohort harmonization runs: uploads, submit, run status, report, review items, the
reviewable items with the organizer's flags, and exports.

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

No absolute server path reaches the client: run status drops ``output_dir``, ``store_dir`` and
each cohort's ``path``, and every response body and error message has the harmonize-home
prefix removed from its strings (see :func:`scrub`).

``JobError`` messages are written for end users and are passed through: 400, except the
runner's unfinished-jobs cap (409) and results asked for before the run finished (409).
"""
from __future__ import annotations

import csv
import dataclasses
import json
import logging
import os
import re
import tempfile
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from biomapper.jobs import FINISHED_STATES, CohortSpec, HarmonizeStatus, JobError
from biomapper.mcp.config import ServerConfig
from fastapi import APIRouter, File, Form, Header, HTTPException, Query, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, ValidationError
from pydantic.alias_generators import to_camel

from services import harmonize_storage
from services.database import database
from services.harmonize_backend import HarmonizeBackend, get_backend
from services.harmonize_export import (
    EITL_FORMATS,
    FORMATS,
    TABLES,
    export_filename,
    export_rows,
    render,
    skipped_one_sided,
)
from services.harmonize_items import FlaggedItem, Item, items_from_report, with_flags
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


def _home_prefixes() -> list[str]:
    """The harmonize home as written and as resolved, longest first."""
    home = harmonize_storage.HARMONIZE_HOME
    found = {str(home), str(Path(home).resolve())}
    return sorted(found, key=len, reverse=True)


def scrub(value: Any) -> Any:
    """Remove the server's harmonize-home prefix from every string in ``value``.

    No absolute path under the harmonize home may reach the client: a path such as
    ``<home>/runs/<id>/inputs/a.tsv`` becomes ``runs/<id>/inputs/a.tsv``; the rest of the text
    is kept.
    """
    if isinstance(value, str):
        for prefix in _home_prefixes():
            value = value.replace(prefix + os.sep, "").replace(prefix, "")
        return value
    if isinstance(value, dict):
        return {k: scrub(v) for k, v in value.items()}
    if isinstance(value, list):
        return [scrub(v) for v in value]
    return value


def _message(exc: BaseException) -> str:
    return scrub(str(exc))


def _job_error(exc: JobError) -> HTTPException:
    return HTTPException(status_code=409 if _is_queue_full(exc) else 400, detail=_message(exc))


_SNAKE_PART = re.compile(r"_([a-z0-9])")
# Values under these keys are maps keyed by data (cohort labels, arm names, vocabularies,
# certificate states, item kinds), not by field names, so their keys are kept as written.
_DATA_KEYED = frozenset({"summary", "counts", "identifiers", "certificate_states", "vocabularies",
                         "rows_per_cohort"})


def _camel_key(key: str) -> str:
    return _SNAKE_PART.sub(lambda m: m.group(1).upper(), key)


def camelize(value: Any) -> Any:
    """Camel-case the field names of a package model dump, leaving data-keyed maps alone."""
    if isinstance(value, dict):
        return {_camel_key(k): (v if k in _DATA_KEYED else camelize(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [camelize(v) for v in value]
    return value


# Server paths the package reports. They never reach the client.
_SERVER_PATH_FIELDS = ("output_dir", "store_dir")


def _run_json(status: HarmonizeStatus, run: dict[str, Any]) -> dict[str, Any]:
    dumped = status.model_dump(mode="json")
    for field in _SERVER_PATH_FIELDS:
        dumped.pop(field, None)
    for cohort in dumped.get("cohorts") or []:
        cohort.pop("path", None)
    out = scrub(camelize(dumped))
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
        return HTTPException(status_code=409, detail=_message(exc))
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

    Any failure removes the run directory and leaves no row; if recording ownership fails
    after the job was accepted, the job is cancelled first.
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
    except Exception as exc:
        _remove_quietly(run_dir)
        if isinstance(exc, CohortFileError):
            raise HTTPException(status_code=400, detail=_message(exc)) from None
        if isinstance(exc, JobError):
            raise _job_error(exc) from None
        raise
    run = {"job_id": status.job_id, "user_id": user_id, "kind": kind,
           "labels": [c.label for c, _, _ in cohorts], "entity": entity,
           "upload_id": upload_id, "created_at": _now_utc()}
    try:
        await database.insert_harmonize_run(**run)
    except Exception:
        # The job was accepted but has no owner: stop it and drop its files, best effort.
        try:
            await backend.cancel(status.job_id)
        except Exception:
            logger.exception("Could not cancel unowned harmonize job %s", status.job_id)
        _remove_quietly(run_dir)
        raise
    return _run_json(status, run)


def _remove_quietly(run_dir: Path) -> None:
    try:
        remove_run_dir(run_dir)
    except OSError:
        logger.exception("Could not remove run directory %s", run_dir)


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
            raise HTTPException(status_code=400, detail=_message(exc)) from None
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
            out.append({"jobId": run["job_id"], "state": "unknown", "reason": _message(exc),
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
        return scrub(backend.load_report(job_id))
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
    return scrub(camelize(page.model_dump(mode="json")))


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
    return scrub(camelize(detail.model_dump(mode="json")))


# ---------------------------------------------------------------------------
# Routes: reviewable items and the organizer's flags
# ---------------------------------------------------------------------------
#
# Items come from the finished run's report.json (services.harmonize_items). An item is flagged
# when biomapper suggested it, unless the organizer stored an override; only overrides are
# stored, and setting an item back to its suggested value deletes its override. flaggedTotal is
# always over every item of the run, whatever the filters.

ItemKind = Literal["link", "group", "review", "unresolved"]
ItemArm = Literal["names_only", "identifier"]
ITEMS_PAGE_DEFAULT = 100
ITEMS_PAGE_MAX = 1000
UNKNOWN_REFS_SHOWN = 10


class FlagsRequest(_CamelModel):
    refs: list[str]
    flagged: bool


class FlagFilter(_CamelModel):
    kind: ItemKind | None = None
    arm: ItemArm | None = None
    basis: str | None = None
    ambiguous: bool | None = None

    def matches(self, item: Item) -> bool:
        # A detail filter matches only items whose detail carries that field.
        return ((self.kind is None or item.kind == self.kind)
                and (self.arm is None or item.arm == self.arm)
                and (self.basis is None or item.detail.get("basis") == self.basis)
                and (self.ambiguous is None or item.detail.get("ambiguous") is self.ambiguous))


class BulkFlagsRequest(_CamelModel):
    filter: FlagFilter
    flagged: bool


class ResetFlagsRequest(_CamelModel):
    refs: list[str] | None = None


# Items of recently used finished runs. A finished run's report.json never changes (a partial
# or complete job cannot be resumed), so its items are built once; the bound keeps memory small
# at the package's limits (12 cohorts of 20,000 rows). Unfinished runs are never cached: their
# load_report raises before anything is stored.
ITEMS_CACHE_RUNS = 4
_items_cache: OrderedDict[str, list[Item]] = OrderedDict()


def clear_items_cache() -> None:
    _items_cache.clear()


def _build_items(backend: HarmonizeBackend, job_id: str) -> list[Item]:
    return items_from_report(backend.load_report(job_id))


async def _run_items(job_id: str) -> list[Item]:
    """The finished run's items, built off the event loop and cached per run."""
    cached = _items_cache.get(job_id)
    if cached is not None:
        _items_cache.move_to_end(job_id)
        return cached
    backend = get_backend()
    try:
        items = await run_in_threadpool(_build_items, backend, job_id)
    except JobError as exc:
        raise await _finished_or_409(backend, job_id, exc) from None
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=_message(exc)) from None
    _items_cache[job_id] = items
    _items_cache.move_to_end(job_id)
    while len(_items_cache) > ITEMS_CACHE_RUNS:
        _items_cache.popitem(last=False)
    return items


# Passes over every item of a run (up to hundreds of thousands at the package's limits) run in
# the threadpool, so a flag toggle never holds the event loop for one of them.


async def _flagged_items(job_id: str, user_id: str, items: list[Item]) -> list[FlaggedItem]:
    overrides = await database.list_harmonize_flags(job_id, user_id)
    return await run_in_threadpool(with_flags, items, overrides)


def _flagged_total(flagged: list[FlaggedItem]) -> int:
    return sum(f.flagged for f in flagged)


def _item_json(f: FlaggedItem) -> dict[str, Any]:
    item = f.item
    return scrub({"ref": item.ref, "kind": item.kind, "arm": item.arm,
                  "members": [dict(m) for m in item.members], "detail": camelize(item.detail),
                  "suggested": item.suggested, "flagged": f.flagged, "source": f.source})


def _known_refs(items: list[Item], refs: list[str]) -> list[str]:
    """``refs`` without repeats, or 400 naming every ref that matches no item of the run."""
    known = {i.ref for i in items}
    wanted = list(dict.fromkeys(refs))
    unknown = [r for r in wanted if r not in known]
    if unknown:
        shown = ", ".join(unknown[:UNKNOWN_REFS_SHOWN])
        more = len(unknown) - UNKNOWN_REFS_SHOWN
        if more > 0:
            shown += f" and {more} more"
        raise HTTPException(status_code=400, detail=f"No item in this run has ref {shown}.")
    return wanted


async def _set_flags(job_id: str, user_id: str, items: list[Item], chosen: list[Item],
                     flagged: bool) -> dict[str, Any]:
    """Set ``chosen`` to ``flagged``: an override where it differs from the suggestion, none
    where it matches."""
    await database.write_harmonize_flags(
        job_id, user_id,
        upsert={i.ref: flagged for i in chosen if i.suggested != flagged},
        delete=[i.ref for i in chosen if i.suggested == flagged],
    )
    flagged_now = await _flagged_items(job_id, user_id, items)
    return {"updated": len(chosen),
            "flaggedTotal": await run_in_threadpool(_flagged_total, flagged_now)}


@router.get("/runs/{job_id}/items")
async def list_items(
    job_id: str,
    kind: ItemKind | None = Query(None),
    arm: ItemArm | None = Query(None),
    flagged: bool | None = Query(None),
    offset: int = Query(0, ge=0),
    limit: int = Query(ITEMS_PAGE_DEFAULT, ge=1, le=ITEMS_PAGE_MAX),
    x_clerk_user_id: str | None = Header(None),
) -> dict[str, Any]:
    """The run's reviewable items with their effective flags, in report order.

    ``total`` counts the items matching the filters; ``flaggedTotal`` counts every flagged item
    of the run.
    """
    user_id = _require_user(x_clerk_user_id)
    await _owned_run(job_id, user_id)
    every = await _flagged_items(job_id, user_id, await _run_items(job_id))

    def page() -> dict[str, Any]:
        chosen = [f for f in every
                  if (kind is None or f.item.kind == kind) and (arm is None or f.item.arm == arm)
                  and (flagged is None or f.flagged == flagged)]
        return {"total": len(chosen), "flaggedTotal": _flagged_total(every),
                "items": [_item_json(f) for f in chosen[offset: offset + limit]]}

    return await run_in_threadpool(page)


@router.put("/runs/{job_id}/flags")
async def set_flags(
    job_id: str, body: FlagsRequest, x_clerk_user_id: str | None = Header(None),
) -> dict[str, Any]:
    """Flag or de-flag the items named by ``refs``; a ref that matches no item is a 400."""
    user_id = _require_user(x_clerk_user_id)
    await _owned_run(job_id, user_id)
    items = await _run_items(job_id)
    wanted = set(await run_in_threadpool(_known_refs, items, body.refs))
    chosen = await run_in_threadpool(lambda: [i for i in items if i.ref in wanted])
    return await _set_flags(job_id, user_id, items, chosen, body.flagged)


@router.post("/runs/{job_id}/flags/bulk")
async def bulk_flags(
    job_id: str, body: BulkFlagsRequest, x_clerk_user_id: str | None = Header(None),
) -> dict[str, Any]:
    """Flag or de-flag every item matching the filter; ``updated`` counts the matches."""
    user_id = _require_user(x_clerk_user_id)
    await _owned_run(job_id, user_id)
    items = await _run_items(job_id)
    chosen = await run_in_threadpool(lambda: [i for i in items if body.filter.matches(i)])
    return await _set_flags(job_id, user_id, items, chosen, body.flagged)


@router.post("/runs/{job_id}/flags/reset")
async def reset_flags(
    job_id: str, body: ResetFlagsRequest | None = None,
    x_clerk_user_id: str | None = Header(None),
) -> dict[str, Any]:
    """Drop the organizer's overrides (all of them when ``refs`` is omitted), so those items
    return to biomapper's suggestion."""
    user_id = _require_user(x_clerk_user_id)
    await _owned_run(job_id, user_id)
    items = await _run_items(job_id)
    refs = (None if body is None or body.refs is None
            else await run_in_threadpool(_known_refs, items, body.refs))
    await database.reset_harmonize_flags(job_id, user_id, refs)
    flagged_now = await _flagged_items(job_id, user_id, items)
    return {"flaggedTotal": await run_in_threadpool(_flagged_total, flagged_now)}


# ---------------------------------------------------------------------------
# Routes: exports
# ---------------------------------------------------------------------------

SKIPPED_ONE_SIDED_HEADER = "X-Harmonize-Skipped-One-Sided"


@router.get("/runs/{job_id}/export")
async def export_run(
    job_id: str,
    table: str | None = Query(None),
    fmt: str | None = Query(None, alias="format"),
    x_clerk_user_id: str | None = Header(None),
) -> Response:
    """Download one table of a finished run (services.harmonize_export) with the caller's
    effective flags, as ``<kind>_<labels>_<table>.<format>``.

    The ``eitl_pairs`` table also reports, in ``X-Harmonize-Skipped-One-Sided``, how many
    flagged items it could not hold.
    """
    user_id = _require_user(x_clerk_user_id)
    await _owned_run(job_id, user_id)
    if table not in TABLES:
        raise HTTPException(status_code=400,
                            detail=f"Unknown table '{table}'. Tables: {', '.join(TABLES)}.")
    if fmt not in FORMATS:
        raise HTTPException(status_code=400,
                            detail=f"Unknown format '{fmt}'. Formats: {', '.join(FORMATS)}.")
    if table == "eitl_pairs" and fmt not in EITL_FORMATS:
        raise HTTPException(status_code=400,
                            detail="The EITL pairs file is CSV or JSON: the expert-in-the-loop "
                                   "upload does not read TSV.")
    flagged = await _flagged_items(job_id, user_id, await _run_items(job_id))
    backend = get_backend()

    def build() -> tuple[bytes, str, str]:
        report = backend.load_report(job_id)
        header, rows = export_rows(report, flagged, table, nested=fmt == "json")
        body, media_type = render(scrub(header), scrub(rows), fmt)
        return body, media_type, export_filename(report, table, fmt)

    try:
        body, media_type, filename = await run_in_threadpool(build)
    except JobError as exc:
        raise await _finished_or_409(backend, job_id, exc) from None
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    if table == "eitl_pairs":
        headers[SKIPPED_ONE_SIDED_HEADER] = str(
            await run_in_threadpool(skipped_one_sided, flagged))
    return Response(content=body, media_type=media_type, headers=headers)
