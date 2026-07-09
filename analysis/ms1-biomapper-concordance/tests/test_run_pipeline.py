"""Unit 2 tests: two-pass runner with a mocked Biomapper client."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import run_pipeline as rp  # noqa: E402


class FakeResult:
    """Mimics biomapper.MappingResult, including confidence_tier as a property."""

    def __init__(self, name, *, resolved=True, identifiers=None, kg=None, error=None,
                 score: float | None = 2.4):
        self.query_name = name
        self.resolved = resolved
        self.primary_curie = "CHEBI:1" if resolved else None
        self.confidence_score = score
        self.chosen_name = name
        self.identifiers = identifiers if identifiers is not None else {"CHEBI": ["1"]}
        self.kg_equivalent_ids = kg or {}
        self.error = error

    @property
    def confidence_tier(self):  # computed property, must be read explicitly
        if self.confidence_score is None:
            return "unknown"
        return "high" if self.confidence_score >= 2.0 else "low"


class FakeClient:
    def __init__(self, responder):
        self.calls = 0
        self.last_records = None
        self._responder = responder

    def __call__(self, records, *, api_key=None, base_url=None, progress=False, timeout=None):
        self.calls += 1
        self.last_records = records
        return [self._responder(r) for r in records]


@pytest.fixture(autouse=True)
def isolate(tmp_path, monkeypatch):
    monkeypatch.setenv("BIOMAPPER_API_KEY", "test-key")
    monkeypatch.delenv("BIOMAPPER_BASE_URL", raising=False)
    monkeypatch.setattr(rp, "OUTPUTS_ROOT", tmp_path / "outputs")
    monkeypatch.setattr(rp, "RAW_CACHE_DIR", tmp_path / "outputs" / "raw")
    return tmp_path


def test_happy_path_preserves_identifiers(isolate):
    client = FakeClient(lambda r: FakeResult(r["name"], identifiers={"CHEBI": ["15971"], "HMDB": []}))
    run_dir = isolate / "outputs" / "run1"
    out = rp.run_pass(["A", "B", "C"], pass_name="name_only", run_dir=run_dir,
                      client_fn=client, progress=False)
    assert len(out) == 3
    assert out[0]["identifiers"] == {"CHEBI": ["15971"], "HMDB": []}
    assert out[0]["confidence_tier"] == "high"
    assert client.calls == 1


def test_empty_identifiers_retained(isolate):
    client = FakeClient(lambda r: FakeResult(r["name"], resolved=False, identifiers={}, score=None))
    out = rp.run_pass(["X"], pass_name="name_only", run_dir=isolate / "outputs" / "r",
                      client_fn=client, progress=False)
    assert out[0]["identifiers"] == {}  # not dropped
    assert out[0]["resolved"] is False
    assert out[0]["confidence_tier"] == "unknown"


def test_persists_raw_json_by_default(isolate):
    client = FakeClient(lambda r: FakeResult(r["name"]))
    run_dir = isolate / "outputs" / "run2"
    rp.run_pass(["A"], pass_name="name_only", run_dir=run_dir, client_fn=client, progress=False)
    snapshot = run_dir / "raw_name_only.json"
    assert snapshot.exists()
    assert json.loads(snapshot.read_text())[0]["query_name"] == "A"


def test_reload_skips_client(isolate):
    client = FakeClient(lambda r: FakeResult(r["name"]))
    rp.run_pass(["A", "B"], pass_name="name_only", run_dir=isolate / "outputs" / "r1",
                client_fn=client, progress=False)
    assert client.calls == 1
    # Second invocation, same names -> reload, zero new client calls.
    out2 = rp.run_pass(["A", "B"], pass_name="name_only", run_dir=isolate / "outputs" / "r2",
                       client_fn=client, progress=False)
    assert client.calls == 1
    assert len(out2) == 2


def test_changed_names_invalidate_reload(isolate):
    client = FakeClient(lambda r: FakeResult(r["name"]))
    rp.run_pass(["A", "B"], pass_name="name_only", run_dir=isolate / "outputs" / "r1",
                client_fn=client, progress=False)
    rp.run_pass(["A", "B", "C"], pass_name="name_only", run_dir=isolate / "outputs" / "r2",
                client_fn=client, progress=False)
    assert client.calls == 2  # name-set changed -> cache ignored


def test_errored_names_resubmitted_and_merged(isolate):
    state = {"first": True}

    def responder(r):
        # Fail every record on the first batch, succeed on the retry.
        if state["first"]:
            return FakeResult(r["name"], resolved=False, error="chunk failure")
        return FakeResult(r["name"], resolved=True)

    class TwoPhaseClient(FakeClient):
        def __call__(self, records, **kw):
            res = super().__call__(records, **kw)
            state["first"] = False
            return res

    client = TwoPhaseClient(responder)
    out = rp.run_pass(["A", "B"], pass_name="name_only", run_dir=isolate / "outputs" / "r",
                      client_fn=client, progress=False)
    assert client.calls == 2  # initial + retry of errored names
    assert all(r["error"] is None and r["resolved"] for r in out)


def test_hinted_records_carry_identifiers(isolate):
    client = FakeClient(lambda r: FakeResult(r["name"]))
    hints = {"A": {"HMDB": "HMDB0000177"}}
    rp.run_pass(["A", "B"], hints_by_name=hints, pass_name="hinted",
                run_dir=isolate / "outputs" / "r", client_fn=client, progress=False)
    assert client.last_records is not None
    recs = {r["name"]: r for r in client.last_records}
    assert recs["A"]["identifiers"] == {"HMDB": "HMDB0000177"}
    assert "identifiers" not in recs["B"]  # no hint -> name only


def test_looks_healthy_small_batch_trusted():
    results = [{"resolved": False, "error": None} for _ in range(10)]
    assert rp.looks_healthy(results) is True  # too small to judge


def test_looks_healthy_large_degraded_is_false():
    results = [{"resolved": False, "error": ""} for _ in range(100)]
    assert rp.looks_healthy(results) is False


def test_looks_healthy_large_normal_is_true():
    results = [{"resolved": True, "error": None} for _ in range(100)]
    assert rp.looks_healthy(results) is True


def test_degraded_large_run_not_cached(isolate):
    # 60 names that all come back unresolved (degraded backend) must NOT poison the cache.
    client = FakeClient(lambda r: FakeResult(r["name"], resolved=False, identifiers={}, error=""))
    names = [f"n{i}" for i in range(60)]
    run_dir = isolate / "outputs" / "deg"
    rp.run_pass(names, pass_name="name_only", run_dir=run_dir, client_fn=client, progress=False)
    # snapshot written, but reload cache must be absent
    assert (run_dir / "raw_name_only.json").exists()
    cache_files = list((isolate / "outputs" / "raw").glob("*.json")) if (isolate / "outputs" / "raw").exists() else []
    assert cache_files == []


def test_paced_retry_recovers(isolate, monkeypatch):
    monkeypatch.setattr(rp.time, "sleep", lambda *_: None)
    state = {"first": True}

    def responder(r):
        return FakeResult(r["name"], resolved=not state["first"])

    class FlakyClient(FakeClient):
        def __call__(self, records, **kw):
            res = super().__call__(records, **kw)
            state["first"] = False  # first sub-batch fails, retry+rest succeed
            return res

    client = FlakyClient(responder)
    names = [f"n{i}" for i in range(120)]  # sub_batch 60 -> 2 batches
    out = rp.run_pass(names, pass_name="name_only", run_dir=isolate / "outputs" / "r",
                      client_fn=client, progress=False, sub_batch=60, pause_s=0)
    assert len(out) == 120
    assert all(r["resolved"] for r in out)  # retry recovered the first batch


def test_paced_aborts_after_failed_retry(isolate, monkeypatch):
    monkeypatch.setattr(rp.time, "sleep", lambda *_: None)
    client = FakeClient(lambda r: FakeResult(r["name"], resolved=False))  # always degraded
    names = [f"n{i}" for i in range(120)]
    with pytest.raises(rp.BackendDegraded):
        rp.run_pass(names, pass_name="name_only", run_dir=isolate / "outputs" / "r",
                    client_fn=client, progress=False, sub_batch=60, pause_s=0)


def test_summarize_counts():
    results = [
        {"resolved": True, "error": None},
        {"resolved": False, "error": "x"},
        {"resolved": True, "error": None},
    ]
    s = rp.summarize(results)
    assert s == {"total": 3, "resolved": 2, "errors": 1}
