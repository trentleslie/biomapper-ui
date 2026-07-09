"""Ground-truth benchmarking API.

Mirrors the map router/job triad but every endpoint is strictly user-scoped: benchmark
runs store the curator's ground-truth dataset (sensitive), so unlike /map there is no
stream/result auth exemption (plan RC-9/RC-10/RC-12). Scoring output is read from the
durable DB, not the in-memory job store.
"""
import json
import uuid
from typing import Any, AsyncIterator

from fastapi import APIRouter, BackgroundTasks, Header, HTTPException, Query
from fastapi.responses import StreamingResponse

from models.benchmark_schemas import BenchmarkRequest, BenchmarkRunUpdate
from services import benchmark_store
from services.database import database
from services.env_routing import resolve_env_base_url
from services.jobs import job_store

router = APIRouter()


def _require_user(x_clerk_user_id: str | None) -> str:
    if not x_clerk_user_id:
        raise HTTPException(status_code=401, detail="Authentication required")
    return x_clerk_user_id


async def _owned_run(run_id: str, user_id: str) -> dict[str, Any]:
    run = await database.get_benchmark_run(run_id)
    if run is None or run.get("user_id") != user_id:
        raise HTTPException(status_code=404, detail="Benchmark run not found")
    return run


@router.post("/batch", response_model=None)
async def start_benchmark(
    request: BenchmarkRequest,
    background_tasks: BackgroundTasks,
    x_biomapper_env: str | None = Header(None),
    x_clerk_user_id: str | None = Header(None),
) -> dict:
    user_id = _require_user(x_clerk_user_id)
    # Defense in depth: reject any benchmark run carrying hints (would feed the answer).
    if request.config.hints:
        raise HTTPException(
            status_code=400,
            detail="Hints are not allowed on benchmark runs (they would inflate scores).",
        )
    env, base_url = resolve_env_base_url(x_biomapper_env)
    run_id = str(uuid.uuid4())
    meta = await benchmark_store.create_run(
        run_id=run_id, request=request, env=env, base_url=base_url, user_id=user_id
    )
    background_tasks.add_task(
        benchmark_store.run_benchmark, run_id, request, base_url, meta["orderAsserted"]
    )
    return {"run_id": run_id}


@router.get("/stream/{run_id}", response_model=None)
async def stream_progress(
    run_id: str,
    x_clerk_user_id: str | None = Header(None),
) -> StreamingResponse:
    user_id = _require_user(x_clerk_user_id)
    await _owned_run(run_id, user_id)  # strict ownership before streaming

    async def event_generator() -> AsyncIterator[str]:
        job_store.purge_expired()
        while True:
            job = job_store.get(run_id)
            if job is None:
                # Job purged/absent — fall back to the durable run status.
                run = await database.get_benchmark_run(run_id)
                status = run["status"] if run else "error"
                yield _sse_event("progress", {"runId": run_id, "status": status})
                break
            yield _sse_event("progress", {**job.to_dict(), "runId": run_id})
            if job.status in ("complete", "error"):
                break
            import asyncio
            await asyncio.sleep(0.5)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@router.get("/result/{run_id}", response_model=None)
async def get_result(
    run_id: str,
    x_clerk_user_id: str | None = Header(None),
) -> dict:
    user_id = _require_user(x_clerk_user_id)
    run = await _owned_run(run_id, user_id)
    if run["status"] in ("pending", "processing"):
        raise HTTPException(status_code=202, detail="Run not yet complete")
    run.pop("user_id", None)
    return run


@router.get("/runs", response_model=None)
async def list_runs(x_clerk_user_id: str | None = Header(None)) -> list[dict]:
    user_id = _require_user(x_clerk_user_id)
    runs = await database.list_benchmark_runs(user_id)
    for r in runs:
        r.pop("user_id", None)
    return runs


@router.get("/runs/{run_id}", response_model=None)
async def get_run(run_id: str, x_clerk_user_id: str | None = Header(None)) -> dict:
    user_id = _require_user(x_clerk_user_id)
    run = await _owned_run(run_id, user_id)
    run.pop("user_id", None)
    return run


@router.patch("/runs/{run_id}", response_model=None)
async def update_run(
    run_id: str,
    update: BenchmarkRunUpdate,
    x_clerk_user_id: str | None = Header(None),
) -> dict:
    user_id = _require_user(x_clerk_user_id)
    await _owned_run(run_id, user_id)
    if update.display_name is not None:
        await database.update_benchmark_run(run_id, display_name=update.display_name)
    run = await _owned_run(run_id, user_id)
    run.pop("user_id", None)
    return run


@router.delete("/runs/{run_id}", response_model=None)
async def delete_run(run_id: str, x_clerk_user_id: str | None = Header(None)) -> dict:
    user_id = _require_user(x_clerk_user_id)
    await _owned_run(run_id, user_id)
    await database.delete_benchmark_run(run_id)
    return {"deleted": True}


@router.get("/runs/{run_id}/rows", response_model=None)
async def get_rows(
    run_id: str,
    limit: int = Query(500, ge=1, le=5000),
    category: str | None = None,
    vocabulary: str | None = None,
    rerankable: bool = False,
    x_clerk_user_id: str | None = Header(None),
) -> list[dict]:
    user_id = _require_user(x_clerk_user_id)
    await _owned_run(run_id, user_id)
    return await database.get_row_logs(
        run_id, limit=limit, category=category, vocabulary=vocabulary, rerankable=rerankable
    )


@router.get("/compare", response_model=None)
async def compare_runs(
    a: str,
    b: str,
    x_clerk_user_id: str | None = Header(None),
) -> dict:
    user_id = _require_user(x_clerk_user_id)
    run_a = await _owned_run(a, user_id)  # ownership enforced on BOTH (RC-9)
    run_b = await _owned_run(b, user_id)
    mismatch = {
        "dataset": run_a.get("dataset_name") != run_b.get("dataset_name"),
        "sdkVersion": run_a.get("sdk_version") != run_b.get("sdk_version"),
        "env": run_a.get("env") != run_b.get("env"),
        "config": run_a.get("config") != run_b.get("config"),
        "orderAsserted": run_a.get("order_asserted") != run_b.get("order_asserted"),
    }
    for r in (run_a, run_b):
        r.pop("user_id", None)
        r.pop("input_names", None)
    return {"a": run_a, "b": run_b, "mismatch": mismatch}


def _sse_event(event_name: str, data: dict) -> str:
    return f"event: {event_name}\ndata: {json.dumps(data)}\n\n"
