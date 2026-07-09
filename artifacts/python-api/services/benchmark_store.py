"""Benchmark run orchestration.

Reuses the existing mapping pipeline (``MapperService.map_batch`` + ``job_store`` for SSE
progress), then chains scoring server-side and persists the run durably BEFORE the run is
marked terminal, so results survive the in-memory job store's 1-hour TTL purge and server
restarts (plan RC-4). ``config.hints`` is stripped for benchmark integrity (plan RC-1/C1).
"""
from __future__ import annotations

import logging

from models.benchmark_schemas import BenchmarkRequest
from models.schemas import MappingConfig
from services import sdk_meta
from services.database import database
from services.jobs import job_store
from services.mapper import MapperService
from services.scorer import score_dataset

logger = logging.getLogger("entity-linker")


def strip_hints(config: MappingConfig) -> MappingConfig:
    """Return a copy of the config with hints removed (benchmark integrity)."""
    data = config.model_dump()
    data["hints"] = {}
    data["hint_columns"] = {}
    return MappingConfig(**data)


def resolve_vocabularies(request: BenchmarkRequest) -> list[str]:
    if request.vocabularies:
        return list(request.vocabularies)
    vocabs: set[str] = set()
    for per_vocab in request.ground_truth.values():
        vocabs.update(per_vocab.keys())
    return sorted(vocabs)


async def create_run(
    *,
    run_id: str,
    request: BenchmarkRequest,
    env: str,
    base_url: str | None,
    user_id: str | None,
) -> dict:
    """Persist the run at dispatch (recoverable) and register the SSE job."""
    meta = sdk_meta.capture(env, base_url)
    vocabularies = resolve_vocabularies(request)
    stored_config = strip_hints(request.config).model_dump(mode="json")
    stored_config["hints_stripped"] = True

    await database.insert_benchmark_run(
        run_id=run_id,
        user_id=user_id,
        dataset_name=request.dataset_name,
        total=len(request.names),
        env=env,
        base_url=base_url,
        sdk_version=meta["sdkVersion"],
        order_asserted=meta["orderAsserted"],
        config=stored_config,
        vocabularies=vocabularies,
        input_names=request.names,
        status="pending",
    )
    await job_store.create(
        run_id, total=len(request.names), env=env, user_id=user_id, config=stored_config
    )
    return meta


async def run_benchmark(
    run_id: str, request: BenchmarkRequest, base_url: str | None, order_asserted: bool
) -> None:
    """Background task: map -> score -> persist durably -> mark terminal."""
    config = strip_hints(request.config)
    mapper = MapperService(base_url_override=base_url)
    results_by_name: dict[str, dict | None] = {}
    try:
        await database.update_benchmark_run(run_id, status="processing")
        async for result in mapper.map_batch(request.names, config):
            job_store.add_result(run_id, result)
            results_by_name[result.get("name")] = result
            if result.get("error_type") in ("auth_failure", "config_error"):
                msg = result.get("error", "Fatal mapping error")
                await database.update_benchmark_run(run_id, status="error", error_message=msg)
                await job_store.error(run_id, msg)
                return

        vocabularies = resolve_vocabularies(request)
        scored = score_dataset(
            request.ground_truth, results_by_name, vocabularies, order_asserted
        )
        # Persist row logs + corpus metrics BEFORE marking terminal (RC-4).
        await database.insert_row_logs(run_id, scored["rows"])
        await database.update_benchmark_run(
            run_id, status="complete", corpus_metrics=scored["corpus"]
        )
        await job_store.complete(run_id)
    except Exception as e:  # noqa: BLE001
        logger.exception("Benchmark run %s failed", run_id)
        await database.update_benchmark_run(run_id, status="error", error_message=str(e))
        await job_store.error(run_id, str(e))
