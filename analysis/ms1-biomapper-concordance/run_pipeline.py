"""Unit 2: two-pass Biomapper runner with default persistence and reload.

- Pass A (name-only) is AUTHORITATIVE for concordance. Pass B (hinted) is lift-only.
- Raw results are persisted by default (paid-API reproducibility SOP).
- Re-run reuse is a simple reload of ``outputs/raw/<pass>_<base_url-hash>.json`` (no
  names+hints hashing); the cached name-set is checked against the request to avoid
  serving stale results.
- ``confidence_tier`` is read explicitly (computed property; ``model_dump()`` drops it).
- On failure, errored ``query_name``s are collected and re-submitted once (covers both
  per-entry no-matches and whole-chunk failures — the SDK returns a flat list, no chunk handle).
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any, Callable

RETRY_PAUSE_S = 10.0

_REPO_ROOT = Path(__file__).resolve().parents[2]
_ANALYSIS_ROOT = Path(__file__).resolve().parent
OUTPUTS_ROOT = _ANALYSIS_ROOT / "outputs"
RAW_CACHE_DIR = OUTPUTS_ROOT / "raw"

# Health guard: a large batch resolving almost nothing means a degraded/throttled backend
# (HTTP 200 with empty matches), NOT a real "no match". Don't cache or trust such a run.
MIN_PLAUSIBLE_RATE = 0.10
MIN_N_FOR_HEALTH_CHECK = 50

# SDK default timeout is 30s; large vector-search batches (~250 names ≈ 22s) can exceed it
# on the 2-worker prod server and come back unresolved. Use a generous timeout.
MAP_TIMEOUT = 180.0


def looks_healthy(results: list[dict]) -> bool:
    """False when a sizable batch resolved implausibly little (degraded backend)."""
    if len(results) < MIN_N_FOR_HEALTH_CHECK:
        return True  # too small to judge; trust it
    rate = summarize(results)["resolved"] / max(1, len(results))
    return rate >= MIN_PLAUSIBLE_RATE


def load_api_key() -> str:
    """Load BIOMAPPER_API_KEY from the repo .env (never printed/logged)."""
    if not os.environ.get("BIOMAPPER_API_KEY"):
        from dotenv import load_dotenv

        load_dotenv(_REPO_ROOT / ".env")
    key = os.environ.get("BIOMAPPER_API_KEY")
    if not key:
        raise RuntimeError(
            "BIOMAPPER_API_KEY not set and not found in repo .env. "
            "See README for setup."
        )
    return key


def base_url() -> str:
    return os.environ.get("BIOMAPPER_BASE_URL", "default")


def _base_url_hash() -> str:
    return hashlib.md5(base_url().encode()).hexdigest()[:8]


def normalize_result(mr: Any) -> dict[str, Any]:
    """Project a Biomapper ``MappingResult`` into a JSON-safe dict, preserving all IDs."""
    return {
        "query_name": getattr(mr, "query_name", None),
        "resolved": bool(getattr(mr, "resolved", False)),
        "primary_curie": getattr(mr, "primary_curie", None),
        # Explicit read — confidence_tier is a computed property, not a model field.
        "confidence_tier": getattr(mr, "confidence_tier", None),
        "confidence_score": getattr(mr, "confidence_score", None),
        "resolved_name": getattr(mr, "chosen_name", None) or getattr(mr, "resolved_name", None),
        # dict(...) copy, NOT list(...), and keep empty {} as a valid "no match".
        "identifiers": dict(getattr(mr, "identifiers", {}) or {}),
        "kg_equivalent_ids": dict(getattr(mr, "kg_equivalent_ids", {}) or {}),
        "error": getattr(mr, "error", None),
    }


def _records(names: list[str], hints_by_name: dict[str, dict[str, str]] | None) -> list[dict]:
    out: list[dict] = []
    for n in names:
        rec: dict[str, Any] = {"name": n}
        if hints_by_name and hints_by_name.get(n):
            rec["identifiers"] = hints_by_name[n]
        out.append(rec)
    return out


def _call(client_fn: Callable, records: list[dict], *, progress: bool) -> list[Any]:
    """Call the mapping client. Real client_fn is biomapper.map_entities."""
    return client_fn(
        records,
        api_key=load_api_key(),
        base_url=None if base_url() == "default" else base_url(),
        progress=progress,
        timeout=MAP_TIMEOUT,
    )


class BackendDegraded(RuntimeError):
    """Raised mid-run when a sub-batch resolves implausibly little (Kestrel throttled)."""


def _call_paced(
    client_fn: Callable, records: list[dict], *, progress: bool,
    sub_batch: int | None, pause_s: float,
) -> list[Any]:
    """Call in sub-batches with pauses to avoid bursting the upstream Kestrel rate limit.

    Aborts early (BackendDegraded) if a sizable sub-batch resolves <MIN_PLAUSIBLE_RATE, so we
    stop hammering — and stop poisoning the server cache — the moment throttling appears.
    """
    if not sub_batch or len(records) <= sub_batch:
        return _call(client_fn, records, progress=progress)

    def resolved_count(rs):
        return sum(1 for r in rs if getattr(r, "resolved", False))

    out: list[Any] = []
    n_batches = (len(records) + sub_batch - 1) // sub_batch
    for bi, i in enumerate(range(0, len(records), sub_batch)):
        chunk = records[i:i + sub_batch]
        res = _call(client_fn, chunk, progress=progress)
        resolved = resolved_count(res)
        degraded = len(chunk) >= MIN_N_FOR_HEALTH_CHECK and resolved / max(1, len(res)) < MIN_PLAUSIBLE_RATE
        if degraded:
            # A cold batch can be slow/empty transiently — retry once after a pause before
            # treating it as a real outage. (Server-side warming usually makes the retry fast.)
            print(f"[paced] sub-batch {bi + 1}/{n_batches}: {resolved}/{len(res)} — retrying once")
            time.sleep(RETRY_PAUSE_S)
            res = _call(client_fn, chunk, progress=progress)
            resolved = resolved_count(res)
            if len(chunk) >= MIN_N_FOR_HEALTH_CHECK and resolved / max(1, len(res)) < MIN_PLAUSIBLE_RATE:
                raise BackendDegraded(
                    f"sub-batch {bi + 1} resolved {resolved}/{len(res)} on retry — aborting to "
                    f"avoid re-poisoning the server cache. {len(out)} names completed before abort."
                )
        print(f"[paced] sub-batch {bi + 1}/{n_batches}: {resolved}/{len(res)} resolved")
        out.extend(res)
        if i + sub_batch < len(records):
            time.sleep(pause_s)
    return out


def run_pass(
    names: list[str],
    hints_by_name: dict[str, dict[str, str]] | None = None,
    *,
    pass_name: str,
    run_dir: Path,
    client_fn: Callable | None = None,
    progress: bool = True,
    retry_errors: bool = True,
    sub_batch: int | None = None,
    pause_s: float = 0.0,
) -> list[dict[str, Any]]:
    """Run one mapping pass over distinct names; persist + reload; return normalized dicts.

    ``client_fn`` defaults to ``biomapper.map_entities`` (injected in tests).
    ``run_dir`` is the timestamped output dir for the SOP snapshot.
    """
    RAW_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    run_dir.mkdir(parents=True, exist_ok=True)
    cache_path = RAW_CACHE_DIR / f"{pass_name}_{_base_url_hash()}.json"

    cached = _load_reload_cache(cache_path, names)
    if cached is not None:
        print(f"[run_pass:{pass_name}] reloaded {len(cached)} results from {cache_path}")
        _persist(cached, run_dir / f"raw_{pass_name}.json")
        return cached

    if client_fn is None:
        from biomapper import map_entities  # type: ignore[import-not-found]

        client_fn = map_entities
    assert client_fn is not None

    raw = _call_paced(client_fn, _records(names, hints_by_name), progress=progress,
                      sub_batch=sub_batch, pause_s=pause_s)
    results = [normalize_result(mr) for mr in raw]

    if retry_errors:
        results = _retry_errored(results, hints_by_name, client_fn, progress)

    # Always snapshot the raw run (debugging/repro). Only write the reload cache if the run
    # looks healthy — never poison the cache with a degraded/throttled all-empty response.
    _persist(results, run_dir / f"raw_{pass_name}.json")
    healthy = looks_healthy(results)
    if healthy:
        _persist(results, cache_path)
    else:
        print(f"[run_pass:{pass_name}] WARNING: only {summarize(results)['resolved']}/"
              f"{len(results)} resolved — backend looks degraded/throttled; NOT caching.")
    print(f"[run_pass:{pass_name}] {summarize(results)['resolved']}/{len(results)} resolved")
    return results


def _retry_errored(
    results: list[dict],
    hints_by_name: dict[str, dict[str, str]] | None,
    client_fn: Callable,
    progress: bool,
) -> list[dict]:
    """Re-submit just the errored query_names once and merge by name."""
    errored = [r["query_name"] for r in results if r.get("error")]
    if not errored:
        return results
    print(f"[run_pass] retrying {len(errored)} errored name(s)")
    retry_raw = _call(client_fn, _records(errored, hints_by_name), progress=progress)
    fixed = {r["query_name"]: r for r in (normalize_result(mr) for mr in retry_raw)}
    return [fixed.get(r["query_name"], r) if r.get("error") else r for r in results]


def summarize(results: list[dict]) -> dict[str, int]:
    return {
        "total": len(results),
        "resolved": sum(1 for r in results if r.get("resolved")),
        "errors": sum(1 for r in results if r.get("error")),
    }


def _persist(results: list[dict], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(results, indent=2, default=str))


def _load_reload_cache(path: Path, names: list[str]) -> list[dict] | None:
    """Return cached results only if the cached name-set matches the request exactly."""
    if not path.exists():
        return None
    try:
        cached = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return None
    if {r.get("query_name") for r in cached} != set(names):
        return None  # stale: input names changed
    return cached
