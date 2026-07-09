"""Benchmark API + orchestration (plan Unit 6).

Uses a fake MapperService (conftest only stubs the biomapper module, not usable client/
result objects — RC-5) and points the singleton DB at a temp file.
"""
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient


class FakeMapper:
    """Drop-in for MapperService; yields preconfigured results per name."""

    outputs: dict[str, dict] = {}

    def __init__(self, base_url_override=None):
        pass

    async def map_batch(self, names, config):
        for n in names:
            yield FakeMapper.outputs.get(
                n, {"name": n, "identifiers": {"hmdb": []}, "kgEquivalentIds": {}}
            )


def _hit(name, ids):
    return {"name": name, "identifiers": {"hmdb": list(ids)}, "kgEquivalentIds": {}}


@pytest.fixture
def client(tmp_path, monkeypatch):
    from services.database import database

    monkeypatch.setattr(database, "_path", tmp_path / "routes.db")
    monkeypatch.setenv("BIOMAPPER_DB_PATH", str(tmp_path / "routes.db"))
    from main import app
    from services.jobs import job_store
    job_store._jobs.clear()
    with patch("services.benchmark_store.MapperService", FakeMapper):
        with TestClient(app) as c:
            yield c


AUTH = {"x-clerk-user-id": "user-a"}


def _run(client, names, ground_truth, dataset="gold", headers=AUTH):
    body = {"names": names, "groundTruth": ground_truth, "datasetName": dataset}
    resp = client.post("/benchmark/batch", json=body, headers=headers)
    return resp


def test_hints_rejected(client):
    FakeMapper.outputs = {}
    body = {
        "names": ["a"], "groundTruth": {"a": {"hmdb": ["HMDB0000001"]}},
        "config": {"hints": {"a": {"HMDB": "HMDB0000001"}}},
    }
    resp = client.post("/benchmark/batch", json=body, headers=AUTH)
    assert resp.status_code == 400
    assert "hints" in resp.json()["detail"].lower()


def test_auth_required(client):
    resp = client.post("/benchmark/batch", json={"names": ["a"], "groundTruth": {}})
    assert resp.status_code == 401


def test_full_run_persists_and_survives_purge(client):
    FakeMapper.outputs = {"a": _hit("a", ["HMDB0000001"]), "b": _hit("b", ["HMDB0000002"])}
    resp = _run(client, ["a", "b"],
                {"a": {"hmdb": ["HMDB0000001"]}, "b": {"hmdb": ["HMDB0000009"]}})
    assert resp.status_code == 200
    run_id = resp.json()["run_id"]

    # Simulate the in-memory job store purge; durable result must survive.
    from services.jobs import job_store
    job_store.evict(run_id)

    result = client.get(f"/benchmark/result/{run_id}", headers=AUTH)
    assert result.status_code == 200
    data = result.json()
    assert data["status"] == "complete"
    corpus = {c["vocabulary"]: c for c in data["corpus_metrics"]}
    assert corpus["hmdb"]["n"] == 2
    assert corpus["hmdb"]["hitAt1"] == 0.5  # a hits, b misses
    assert "input_names" not in data or data.get("input_names")  # get includes it


def test_run_error_excluded_from_denominator(client):
    FakeMapper.outputs = {
        "a": _hit("a", ["HMDB0000001"]),
        "b": {"name": "b", "error_type": "mapping_error", "error": "boom",
              "identifiers": {}, "kgEquivalentIds": {}},
    }
    resp = _run(client, ["a", "b"],
                {"a": {"hmdb": ["HMDB0000001"]}, "b": {"hmdb": ["HMDB0000009"]}})
    run_id = resp.json()["run_id"]
    data = client.get(f"/benchmark/result/{run_id}", headers=AUTH).json()
    corpus = {c["vocabulary"]: c for c in data["corpus_metrics"]}
    assert corpus["hmdb"]["n"] == 1  # b excluded as RUN_ERROR
    assert corpus["hmdb"]["hitAt1"] == 1.0
    assert corpus["hmdb"]["runErrorCount"] == 1


def test_fatal_run_marked_error_not_all_miss(client):
    FakeMapper.outputs = {
        "a": {"name": "a", "error_type": "auth_failure", "error": "bad key",
              "identifiers": {}, "kgEquivalentIds": {}},
    }
    resp = _run(client, ["a"], {"a": {"hmdb": ["HMDB0000001"]}})
    run_id = resp.json()["run_id"]
    data = client.get(f"/benchmark/result/{run_id}", headers=AUTH).json()
    assert data["status"] == "error"
    assert not data.get("corpus_metrics")  # never scored as all-miss


def test_rows_filters(client):
    FakeMapper.outputs = {
        "a": _hit("a", ["HMDB0000001"]),                          # exact rank 0
        "b": _hit("b", ["HMDB9999999", "HMDB0000002"]),           # hit rank 1 -> rerankable
        "c": _hit("c", ["HMDB9999999"]),                          # miss
    }
    resp = _run(client, ["a", "b", "c"], {
        "a": {"hmdb": ["HMDB0000001"]},
        "b": {"hmdb": ["HMDB0000002"]},
        "c": {"hmdb": ["HMDB0000003"]},
    })
    run_id = resp.json()["run_id"]
    rer = client.get(f"/benchmark/runs/{run_id}/rows", params={"rerankable": True}, headers=AUTH).json()
    assert [r["name"] for r in rer] == ["b"]
    misses = client.get(f"/benchmark/runs/{run_id}/rows", params={"category": "NO_OVERLAP"}, headers=AUTH).json()
    assert [r["name"] for r in misses] == ["c"]


def test_compare_ownership_and_mismatch(client):
    FakeMapper.outputs = {"a": _hit("a", ["HMDB0000001"])}
    r1 = _run(client, ["a"], {"a": {"hmdb": ["HMDB0000001"]}}, dataset="ds1").json()["run_id"]
    r2 = _run(client, ["a"], {"a": {"hmdb": ["HMDB0000001"]}}, dataset="ds2").json()["run_id"]
    cmp = client.get("/benchmark/compare", params={"a": r1, "b": r2}, headers=AUTH).json()
    assert cmp["mismatch"]["dataset"] is True
    assert cmp["mismatch"]["env"] is False

    # user-b cannot compare user-a's runs
    denied = client.get("/benchmark/compare", params={"a": r1, "b": r2},
                        headers={"x-clerk-user-id": "user-b"})
    assert denied.status_code == 404


def test_cross_user_run_access_404(client):
    FakeMapper.outputs = {"a": _hit("a", ["HMDB0000001"])}
    run_id = _run(client, ["a"], {"a": {"hmdb": ["HMDB0000001"]}}).json()["run_id"]
    resp = client.get(f"/benchmark/runs/{run_id}", headers={"x-clerk-user-id": "user-b"})
    assert resp.status_code == 404


def test_oversized_ground_truth_rejected(client):
    FakeMapper.outputs = {}
    body = {"names": ["a"], "groundTruth": {"a": {"hmdb": ["x"] * 501}}}
    resp = client.post("/benchmark/batch", json=body, headers=AUTH)
    assert resp.status_code in (400, 422)
