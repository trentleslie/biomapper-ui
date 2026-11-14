"""The built-in examples and their committed recordings of real runs.

``data/harmonize_examples/<kind>/`` holds invented panel metadata (see each ``SOURCE.md``) and
``recording/``, one real run of it against the hosted BioMapper API. These tests check the
recordings hold every item kind, replay to their recorded finish, and drive the run, items,
flags and export routes (Tasks 4, 6 and 7) the same way the package-generated fixtures do.
"""
import csv
import io
import json
import re
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from biomapper.jobs import FINISHED_STATES, HarmonizeStatus
from routes.harmonize import EXAMPLES_DIR
from services.harmonize_export import EITL_COLUMNS, FORMATS, TABLES, export_rows, render
from services.harmonize_items import items_from_report, with_flags
from services.harmonize_replay import RECORDING_SUBDIR, ReplayBackend, _Recording
from tests.harmonize_fixtures import wait_finished

U1 = {"x-clerk-user-id": "user-1"}
KINDS = {"two_cohort": "harmonize_cohorts", "many_cohort": "harmonize_many"}
RECORDING_FILES = ("report.json", "status.json", "progress.jsonl", "review_items.json",
                   "PINS.md")


def recording(kind: str) -> Path:
    return EXAMPLES_DIR / kind / RECORDING_SUBDIR


def report_of(kind: str) -> dict:
    return json.loads((recording(kind) / "report.json").read_text(encoding="utf-8"))


def labels_of(kind: str) -> list[str]:
    spec = json.loads((EXAMPLES_DIR / kind / "spec.json").read_text(encoding="utf-8"))
    cohorts = [spec["a"], spec["b"]] if kind == "two_cohort" else spec["cohorts"]
    return [c["label"] for c in cohorts]


# ---------------------------------------------------------------------------
# The recordings themselves
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("kind", KINDS)
def test_recording_has_every_item_kind(kind):
    report = report_of(kind)
    assert report["kind"] == KINDS[kind]
    items = items_from_report(report)
    kinds = {i.kind for i in items}
    if kind == "two_cohort":
        assert {"link", "review", "unresolved"} <= kinds
        links = [i for i in items if i.kind == "link"]
        assert any(i.detail["ambiguous"] for i in links), "no ambiguous link"
        assert any(not i.detail["ambiguous"] for i in links), "no plain link"
    else:
        assert {"group", "review", "unresolved"} <= kinds
        groups = [i for i in items if i.kind == "group"]
        assert any(i.detail["multiplicity"] for i in groups), "no group with multiplicity"
        assert any(not i.detail["multiplicity"] for i in groups), "no plain group"
    unresolved_cohorts = {m["cohort"] for i in items if i.kind == "unresolved" for m in i.members}
    assert unresolved_cohorts == set(labels_of(kind)), "every cohort has an unresolved row"


@pytest.mark.parametrize("kind", KINDS)
def test_recording_is_complete_and_holds_no_local_path(kind):
    directory = recording(kind)
    loaded = _Recording.load(directory)  # what ReplayBackend validates
    assert loaded.finished.kind == KINDS[kind]
    assert loaded.progress and set(loaded.review) == {"skipped_no_node", "items", "details"}
    assert set(loaded.review["details"]) == {i["ref"] for i in loaded.review["items"]}
    for name in RECORDING_FILES:
        text = (directory / name).read_text(encoding="utf-8")
        for needle in ("/home/", "/Users/", "/tmp/", "/var/", "C:\\"):
            assert needle not in text, f"{name} holds a local path ({needle})"
    pins = (directory / "PINS.md").read_text(encoding="utf-8")
    assert "biomapper version: 1.9" in pins and "git SHA" in pins
    assert f"scripts/record_harmonize_run.py {kind}" in pins


def unconfirmed_rows(report: dict) -> set[str]:
    """Keys of rows whose declared identifier the recording does not confirm against the row's
    names-only node: the identifier arm chose another node, or the names-only identifier
    check left it unconfirmed (many-cohort ``id_check_review``)."""
    if report["kind"] == "harmonize_cohorts":
        def arm(name):
            return {(label, row["key"]): row for label, rows in report["mappings"][name].items()
                    for row in rows}
        names, ids = arm("names_only"), arm("identifier")
    else:
        def arm(name):
            return {(row["cohort"], row["key"]): row for row in report["arms"][name]["rows"]}
        names, ids = arm("names_only"), arm("identifier")
    keys = {key for (cohort, key), row in names.items()
            if (cohort, key) in ids and ids[(cohort, key)]["chosen_kg_id"] != row["chosen_kg_id"]}
    for name in ("names_only", "identifier"):
        keys |= {e["key"] for e in report["arms"].get(name, {}).get("id_check_review") or []}
    return keys


@pytest.mark.parametrize("kind", KINDS)
def test_source_names_every_unconfirmed_identifier(kind):
    keys = unconfirmed_rows(report_of(kind))
    assert keys, "the recording has rows whose identifier the names-only node does not carry"
    source = (EXAMPLES_DIR / kind / "SOURCE.md").read_text(encoding="utf-8")
    section = source.split("## Known identifier notes", 1)[1].split("\n## ", 1)[0]
    assert "checked only against the recorded run" in section
    missing = sorted(k for k in keys if not re.search(rf"\b{re.escape(k)}\b", section))
    assert not missing, f"SOURCE.md 'Known identifier notes' does not name {missing}"


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", KINDS)
async def test_replay_plays_the_committed_recording_to_its_finish(kind, tmp_path):
    loaded = _Recording.load(recording(kind))
    async with ReplayBackend(EXAMPLES_DIR) as backend:
        submit = backend.submit_cohorts if kind == "two_cohort" else backend.submit_many
        args = ([None, None] if kind == "two_cohort" else [[]])
        status = await submit(*args, entity="metabolites", output_dir=tmp_path / "out")
        done = await wait_finished(backend, status.job_id)
        assert isinstance(done, HarmonizeStatus) and done.state == loaded.finished.state
        assert done.state in FINISHED_STATES
        assert done.entities_mapped == loaded.finished.entities_mapped
        assert done.summary == loaded.finished.summary
        assert done.progress == loaded.progress[-1]
        assert backend.load_report(done.job_id) == report_of(kind)
        page = backend.review_items(done.job_id, limit=50)
        assert page.total == len(loaded.review["items"])


# ---------------------------------------------------------------------------
# Routes on the committed recordings
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _fresh_items_cache():
    from routes.harmonize import clear_items_cache

    clear_items_cache()
    yield
    clear_items_cache()


@pytest.fixture
def client(tmp_path, monkeypatch):
    from services.database import database

    monkeypatch.setenv("BIOMAPPER_HARMONIZE_REPLAY_DIR", str(EXAMPLES_DIR))
    monkeypatch.setattr(database, "_path", tmp_path / "harmonize_examples.db")
    from main import app

    with TestClient(app) as c:
        yield c


def start_example(client, kind):
    r = client.post("/harmonize/example", json={"kind": kind}, headers=U1)
    assert r.status_code == 200, r.text
    job = r.json()["jobId"]
    deadline = time.monotonic() + 30
    while True:
        st = client.get(f"/harmonize/runs/{job}", headers=U1).json()
        if st["state"] in FINISHED_STATES:
            return job, st
        assert time.monotonic() < deadline, f"run {job} still {st['state']}"
        time.sleep(0.02)


def items(client, job, **params):
    r = client.get(f"/harmonize/runs/{job}/items", params={"limit": 1000, **params}, headers=U1)
    assert r.status_code == 200, r.text
    return r.json()


@pytest.mark.parametrize("kind", KINDS)
def test_example_route_runs_on_replay(client, kind):
    job, status = start_example(client, kind)
    assert status["kind"] == KINDS[kind] and status["state"] == "complete"
    report = client.get(f"/harmonize/runs/{job}/report", headers=U1)
    assert report.status_code == 200
    assert report.json() == report_of(kind)
    runs = client.get("/harmonize/runs", headers=U1).json()
    assert [r["labels"] for r in runs if r["jobId"] == job] == [labels_of(kind)]


@pytest.mark.parametrize("kind", KINDS)
def test_items_route_on_recording(client, kind):
    job, _ = start_example(client, kind)
    body = items(client, job)
    expected = items_from_report(report_of(kind))
    assert [i["ref"] for i in body["items"]] == [i.ref for i in expected]
    assert body["total"] == len(expected)
    assert body["flaggedTotal"] == sum(i.suggested for i in expected)
    for item_kind in {i.kind for i in expected}:
        part = items(client, job, kind=item_kind)
        assert part["total"] == sum(i.kind == item_kind for i in expected)
    page = items(client, job, offset=2, limit=3)
    assert [i["ref"] for i in page["items"]] == [i["ref"] for i in body["items"][2:5]]


@pytest.mark.parametrize("kind", KINDS)
def test_flags_on_recording(client, kind):
    job, _ = start_example(client, kind)
    every = items(client, job)["items"]
    base = f"/harmonize/runs/{job}"
    suggested = next(i for i in every if i["suggested"])["ref"]
    r = client.put(f"{base}/flags", json={"refs": [suggested], "flagged": False}, headers=U1)
    assert r.status_code == 200 and r.json()["updated"] == 1
    after = next(i for i in items(client, job)["items"] if i["ref"] == suggested)
    assert (after["flagged"], after["source"]) == (False, "organizer")
    r = client.post(f"{base}/flags/reset", json={"refs": [suggested]}, headers=U1)
    assert r.json()["flaggedTotal"] == sum(i["flagged"] for i in every)
    r = client.post(f"{base}/flags/bulk", json={"filter": {"kind": "unresolved"}, "flagged": True},
                    headers=U1)
    assert r.json()["updated"] == sum(i["kind"] == "unresolved" for i in every)


@pytest.mark.parametrize("kind", KINDS)
def test_exports_on_recording(client, kind):
    job, _ = start_example(client, kind)
    report = report_of(kind)
    flagged = with_flags(items_from_report(report), {})
    for table in TABLES:
        for fmt in FORMATS:
            r = client.get(f"/harmonize/runs/{job}/export", params={"table": table, "format": fmt},
                           headers=U1)
            if table == "eitl_pairs" and fmt == "tsv":
                assert r.status_code == 400
                continue
            assert r.status_code == 200, (table, fmt, r.text)
            header, rows = export_rows(report, flagged, table, nested=fmt == "json")
            assert r.content == render(header, rows, fmt)[0]
    every = {i.ref for i in items_from_report(report)}
    client.put(f"/harmonize/runs/{job}/flags", json={"refs": sorted(every), "flagged": True},
               headers=U1)
    r = client.get(f"/harmonize/runs/{job}/export", params={"table": "eitl_pairs",
                                                            "format": "csv"}, headers=U1)
    records = list(csv.DictReader(io.StringIO(r.content.decode("utf-8"), newline="")))
    assert records and list(records[0]) == EITL_COLUMNS
    assert all(rec["source_text"].strip() and rec["source_id"].strip()
               and rec["target_text"].strip() and rec["target_id"].strip() for rec in records)
