"""Real harmonize route response bodies validate against lib/api-spec/openapi.yaml.

The generated Zod schemas and TypeScript types come from that spec, so a body the server
sends but the spec does not allow is rejected by the client. Bodies here come from the routes
driven over the committed recordings of real runs (data/harmonize_examples), and from a
finished-jobs run built from stored mapping-job rows.

The spec declares OpenAPI 3.1 but marks nullable fields with the 3.0 ``nullable: true``
keyword, which orval honours (it emits ``.nullable()``/``.nullish()``) and JSON Schema
2020-12 ignores. _jsonschema() rewrites each such schema to ``anyOf: [schema, null]`` so the
validator reads nullability the way the generated clients do.
"""
import time
from pathlib import Path
from typing import Any

import pytest
import yaml
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator

from biomapper.jobs import FINISHED_STATES
from routes.harmonize import EXAMPLES_DIR
from tests.test_harmonize_offline import _body, insert, row, unresolved, errored

SPEC_PATH = Path(__file__).resolve().parents[3] / "lib" / "api-spec" / "openapi.yaml"
U1 = {"x-clerk-user-id": "user-1"}


def _jsonschema(node: Any) -> Any:
    if isinstance(node, list):
        return [_jsonschema(n) for n in node]
    if not isinstance(node, dict):
        return node
    out = {k: _jsonschema(v) for k, v in node.items() if k != "nullable"}
    if node.get("nullable") is True:
        return {"anyOf": [out, {"type": "null"}]}
    return out


SPEC = yaml.safe_load(SPEC_PATH.read_text(encoding="utf-8"))
COMPONENTS = _jsonschema(SPEC["components"])


def check(method: str, path: str, body: Any) -> None:
    """Validate ``body`` against the 200 application/json schema of ``method path``."""
    schema = SPEC["paths"][path][method]["responses"]["200"]["content"]["application/json"]["schema"]
    validator = Draft202012Validator({**_jsonschema(schema), "components": COMPONENTS})
    errors = sorted(validator.iter_errors(body), key=lambda e: list(e.absolute_path))
    assert not errors, f"{method.upper()} {path}:\n" + "\n".join(
        f"  at {list(e.absolute_path)}: {e.message[:300]}" for e in errors)


@pytest.fixture(autouse=True)
def _fresh_items_cache():
    from routes.harmonize import clear_items_cache

    clear_items_cache()
    yield
    clear_items_cache()


def _client(tmp_path, monkeypatch, pace: str):
    from services.database import database

    monkeypatch.setenv("BIOMAPPER_HARMONIZE_REPLAY_DIR", str(EXAMPLES_DIR))
    monkeypatch.setenv("BIOMAPPER_HARMONIZE_REPLAY_PACE", pace)
    monkeypatch.setattr(database, "_path", tmp_path / "harmonize_conformance.db")
    from main import app

    return TestClient(app)


@pytest.fixture
def client(tmp_path, monkeypatch):
    # Paced so the polls below see the run queued, running (with progress) and finished.
    with _client(tmp_path, monkeypatch, "0.02") as c:
        yield c


@pytest.fixture
def slow_client(tmp_path, monkeypatch):
    with _client(tmp_path, monkeypatch, "5") as c:
        yield c


def _run_example(client, kind: str) -> tuple[str, set[str]]:
    """Start an example run, validating its submit body and every status polled to the end."""
    r = client.post("/harmonize/example", json={"kind": kind}, headers=U1)
    assert r.status_code == 200, r.text
    check("post", "/harmonize/example", r.json())
    job = r.json()["jobId"]
    states = {r.json()["state"]}
    deadline = time.monotonic() + 60
    while True:
        st = client.get(f"/harmonize/runs/{job}", headers=U1)
        assert st.status_code == 200, st.text
        check("get", "/harmonize/runs/{jobId}", st.json())
        running_with_progress = st.json()["state"] == "running" and st.json().get("progress")
        states.add("running:progress" if running_with_progress else st.json()["state"])
        if st.json()["state"] in FINISHED_STATES:
            return job, states
        assert time.monotonic() < deadline, f"run {job} still {st.json()['state']}"
        time.sleep(0.01)


def _check_run_routes(client, job: str) -> None:
    """Report, items, flags and review-items bodies of one finished run."""
    base = f"/harmonize/runs/{job}"
    r = client.get(f"{base}/report", headers=U1)
    assert r.status_code == 200, r.text
    check("get", "/harmonize/runs/{jobId}/report", r.json())

    page = client.get(f"{base}/items", params={"limit": 1000}, headers=U1)
    assert page.status_code == 200, page.text
    check("get", "/harmonize/runs/{jobId}/items", page.json())
    refs = [i["ref"] for i in page.json()["items"]]
    assert refs

    r = client.put(f"{base}/flags", json={"refs": refs[:1], "flagged": True}, headers=U1)
    assert r.status_code == 200, r.text
    check("put", "/harmonize/runs/{jobId}/flags", r.json())
    r = client.post(f"{base}/flags/bulk", json={"filter": {"kind": "unresolved"}, "flagged": True},
                    headers=U1)
    assert r.status_code == 200, r.text
    check("post", "/harmonize/runs/{jobId}/flags/bulk", r.json())
    r = client.post(f"{base}/flags/reset", json={}, headers=U1)
    assert r.status_code == 200, r.text
    check("post", "/harmonize/runs/{jobId}/flags/reset", r.json())

    review = client.get(f"{base}/review-items", params={"limit": 50}, headers=U1)
    assert review.status_code == 200, review.text
    check("get", "/harmonize/runs/{jobId}/review-items", review.json())
    for item in review.json()["items"][:5]:
        detail = client.get(f"{base}/review-items/{item['ref']}", headers=U1)
        assert detail.status_code == 200, detail.text
        check("get", "/harmonize/runs/{jobId}/review-items/{ref}", detail.json())


@pytest.mark.parametrize("kind", ["two_cohort", "many_cohort"])
def test_example_run_bodies_match_the_spec(client, kind):
    job, states = _run_example(client, kind)
    assert "running:progress" in states and "complete" in states, states
    _check_run_routes(client, job)
    runs = client.get("/harmonize/runs", headers=U1)
    check("get", "/harmonize/runs", runs.json())


def test_from_jobs_run_bodies_match_the_spec(client):
    insert(client, "ja", "user-1", [row("Glucose", {"HMDB": ["HMDB0000122"]}),
                                    row("Hexose", {}, chosenKgIdReview="divergent_refmet"),
                                    unresolved("Mystery")])
    insert(client, "jb", "user-1", [row("D-glucose", {"HMDB": ["HMDB0000122"]}),
                                    errored("Broken")])
    r = client.post("/harmonize/from-jobs", json=_body(), headers=U1)
    assert r.status_code == 200, r.text
    check("post", "/harmonize/from-jobs", r.json())
    assert r.json()["progress"] is None
    job = r.json()["jobId"]
    check("get", "/harmonize/runs/{jobId}", client.get(f"/harmonize/runs/{job}", headers=U1).json())
    _check_run_routes(client, job)
    check("get", "/harmonize/runs", client.get("/harmonize/runs", headers=U1).json())


def test_cancel_and_resume_bodies_match_the_spec(slow_client):
    r = slow_client.post("/harmonize/example", json={"kind": "two_cohort"}, headers=U1)
    job = r.json()["jobId"]
    assert r.json()["state"] == "queued"
    cancelled = slow_client.post(f"/harmonize/runs/{job}/cancel", headers=U1)
    assert cancelled.status_code == 200, cancelled.text
    check("post", "/harmonize/runs/{jobId}/cancel", cancelled.json())
    resumed = slow_client.post(f"/harmonize/runs/{job}/resume", headers=U1)
    assert resumed.status_code == 200, resumed.text
    check("post", "/harmonize/runs/{jobId}/resume", resumed.json())
    slow_client.post(f"/harmonize/runs/{job}/cancel", headers=U1)


def test_the_check_rejects_a_body_the_spec_forbids():
    with pytest.raises(AssertionError, match="jobId"):
        check("get", "/harmonize/runs/{jobId}", {"state": "complete"})
