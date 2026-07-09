"""Tests for the MW RefMet id->name resolver (network mocked)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import refmet_api  # noqa: E402


def test_resolves_and_normalizes(tmp_path):
    fake = {"RM0129894": "Histidine", "RM0135901": "D-Glucose"}
    out = refmet_api.resolve_refmet_names(
        ["RM0129894", "RM0135901"], tmp_path / "cache.json",
        fetch=lambda rid: fake.get(rid),
    )
    assert out == {"RM0129894": "histidine", "RM0135901": "dglucose"}  # normalized


def test_miss_cached_and_excluded(tmp_path):
    calls = []

    def fetch(rid):
        calls.append(rid)
        return None  # MW has no match

    cache = tmp_path / "cache.json"
    out = refmet_api.resolve_refmet_names(["RMxxxx"], cache, fetch=fetch)
    assert out == {}                      # unresolved excluded from result
    assert json.loads(cache.read_text()) == {"RMxxxx": None}  # miss cached
    # second call must not re-fetch the cached miss
    refmet_api.resolve_refmet_names(["RMxxxx"], cache, fetch=fetch)
    assert calls == ["RMxxxx"]            # fetched once only


def test_cache_hit_skips_fetch(tmp_path):
    cache = tmp_path / "cache.json"
    cache.write_text(json.dumps({"RM0129894": "histidine"}))
    calls = []
    out = refmet_api.resolve_refmet_names(
        ["RM0129894"], cache, fetch=lambda rid: calls.append(rid) or "SHOULD_NOT_BE_USED")
    assert out == {"RM0129894": "histidine"}
    assert calls == []  # served from cache, no fetch
