"""Resolve Biomapper RefMet IDs -> canonical RefMet names via the Metabolomics Workbench REST API.

Biomapper returns RefMet *IDs* (e.g. ``RM0129894``); the curated reference has RefMet *names*
(e.g. ``Histidine``). MW is the RefMet authority (and the source Biomapper itself uses), so we
convert IDs -> names with one small GET per *distinct* ID, cached on disk so reruns are free.

    GET /rest/refmet/refmet_id/<RM id>/name/  ->  {"refmet_id": "...", "name": "Histidine"}

Only the IDs we actually need to compare (features where the reference has a RefMet name) should
be passed in, to keep the number of lookups small.
"""

from __future__ import annotations

import json
import urllib.request
from pathlib import Path
from typing import Callable, Iterable

import io_and_normalize as io

MW_NAME_URL = "https://www.metabolomicsworkbench.org/rest/refmet/refmet_id/{}/name/"


def _http_fetch_name(refmet_id: str, timeout: float = 30.0) -> str | None:
    """Fetch the RefMet name for one ID from MW. Returns the raw name or None on miss/error."""
    try:
        with urllib.request.urlopen(MW_NAME_URL.format(refmet_id), timeout=timeout) as resp:
            data = json.loads(resp.read().decode())
        name = data.get("name") if isinstance(data, dict) else None
        return name or None
    except Exception:
        return None


def resolve_refmet_names(
    refmet_ids: Iterable[str],
    cache_path: str | Path,
    *,
    fetch: Callable[[str], str | None] = _http_fetch_name,
) -> dict[str, str]:
    """Map ``{refmet_id -> normalized name}`` for the given IDs, using an on-disk cache.

    ``fetch`` is injectable for testing. Misses (no MW match) are cached as ``None`` so we don't
    re-query them. Only IDs that resolve to a name are returned.
    """
    cache_path = Path(cache_path)
    cache: dict[str, str | None] = {}
    if cache_path.exists():
        try:
            cache = json.loads(cache_path.read_text())
        except (json.JSONDecodeError, OSError):
            cache = {}

    dirty = False
    for rid in sorted({r for r in refmet_ids if r}):
        if rid not in cache:
            raw = fetch(rid)
            cache[rid] = io.normalize_name(raw) if raw else None
            dirty = True

    if dirty:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(cache, indent=0))

    return {rid: nm for rid, nm in cache.items() if nm}
