"""Harmonize run routes: ownership, uploads, submit failures and the camelCase run status.

Every test runs on the ReplayBackend (autouse ``_isolated_harmonize``), so a run finishes in
a few event-loop turns. Replay ignores the submitted specs, so bad input is caught by the
route layer before submit.
"""
import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from biomapper.jobs import FINISHED_STATES, JobError
from services.harmonize_storage import runs_root

U1 = {"x-clerk-user-id": "user-1"}
U2 = {"x-clerk-user-id": "user-2"}

A_TSV = b"name\thmdb\nGlucose\tHMDB0000122\nLactate\tHMDB0000190\n"
B_TSV = b"name\thmdb\nD-Glucose\tHMDB0000122\nL-Lactic acid\t\n"
C_CSV = b"name,hmdb\nCitrate,HMDB0000094\n"


def _cohort(label):
    return {"label": label, "nameColumn": "name", "vocabularies": {"HMDB": ["hmdb"]}}


@pytest.fixture
def spec_two():
    return {"entity": "metabolites", "a": _cohort("a"), "b": _cohort("b")}


@pytest.fixture
def spec_many():
    return {"entity": "metabolites", "cohorts": [_cohort("a"), _cohort("b"), _cohort("c")]}


@pytest.fixture
def two_files():
    return {"fileA": ("a.tsv", A_TSV, "text/tab-separated-values"),
            "fileB": ("b.tsv", B_TSV, "text/tab-separated-values")}


def files_with_a(data):
    return {"fileA": ("a.tsv", data, "text/tab-separated-values"),
            "fileB": ("b.tsv", B_TSV, "text/tab-separated-values")}


def many_files(n):
    return [("files", (f"c{i}.tsv", A_TSV, "text/tab-separated-values")) for i in range(n)]


def _make_client(tmp_path, monkeypatch):
    from services.database import database

    monkeypatch.setattr(database, "_path", tmp_path / "harmonize_routes.db")
    from main import app

    return TestClient(app)


@pytest.fixture
def client(tmp_path, monkeypatch):
    with _make_client(tmp_path, monkeypatch) as c:
        yield c


@pytest.fixture
def slow_client(tmp_path, monkeypatch):
    """Replay slow enough that a run is still going while the test looks at it."""
    monkeypatch.setenv("BIOMAPPER_HARMONIZE_REPLAY_PACE", "5")
    with _make_client(tmp_path, monkeypatch) as c:
        yield c


QUEUE_FULL = ("This session already has 3 unfinished harmonize job(s) (limit 3); jobs run one "
              "at a time. Wait for one to finish, or cancel_job it.")


class _CapBackend:
    """Refuses every submit the way HarmonizeJobs does when its unfinished-jobs cap is hit."""

    def __init__(self, message=QUEUE_FULL):
        self.message = message

    async def submit_cohorts(self, *args, **kwargs):
        raise JobError(self.message)

    async def submit_many(self, *args, **kwargs):
        raise JobError(self.message)


@pytest.fixture
def client_with_cap_backend(client, monkeypatch):
    import routes.harmonize as harmonize_routes

    monkeypatch.setattr(harmonize_routes, "get_backend", lambda: _CapBackend())
    return client


def wait_complete(client, job, headers, timeout_s=30.0):
    deadline = time.monotonic() + timeout_s
    while True:
        st = client.get(f"/harmonize/runs/{job}", headers=headers).json()
        if st["state"] in FINISHED_STATES:
            return st
        assert time.monotonic() < deadline, f"run {job} still {st['state']}"
        time.sleep(0.02)


@pytest.fixture
def finished_job(client, two_files, spec_two):
    r = client.post("/harmonize/cohorts", files=two_files,
                    data={"spec": json.dumps(spec_two)}, headers=U1)
    assert r.status_code == 200, r.text
    job = r.json()["jobId"]
    wait_complete(client, job, U1)
    return job


# -- submit ------------------------------------------------------------------


def test_two_cohort_submit_then_report(client, two_files, spec_two):
    r = client.post("/harmonize/cohorts", files=two_files, data={"spec": json.dumps(spec_two)}, headers=U1)
    assert r.status_code == 200
    job = r.json()["jobId"]
    wait_complete(client, job, U1)
    rep = client.get(f"/harmonize/runs/{job}/report", headers=U1).json()
    assert rep["schema_version"] == 1 and rep["kind"] == "harmonize_cohorts"


def test_run_status_is_camel_case_with_run_fields(client, finished_job):
    st = client.get(f"/harmonize/runs/{finished_job}", headers=U1).json()
    assert st["jobId"] == finished_job
    assert st["kind"] == "harmonize_cohorts"
    assert st["labels"] == ["a", "b"]
    assert st["entity"] == "metabolites"
    assert st["createdAt"].endswith("Z")
    for key in ("entitiesTotal", "entitiesMapped", "rowsErrored", "createdUtc",
                "updatedUtc", "kgBuild", "kgVerified", "reviewItems"):
        assert key in st, key
    assert not [k for k in st if "_" in k]
    assert set(st["progress"]) >= {"entitiesDone", "entitiesTotal", "function", "arm"}
    assert st["reviewItems"]["skippedNoNode"] == 0
    assert set(st["cohorts"][0]) == {"label", "rows"}
    assert "outputDir" not in st and "storeDir" not in st
    # summary is the package's free-form block and passes through as written
    assert st["summary"] == {"links": 2, "warnings": []}


def test_run_dirs_are_per_run(client, finished_job):
    dirs = list(runs_root().iterdir())
    assert len(dirs) == 1
    run_dir = dirs[0]
    assert sorted(p.name for p in (run_dir / "inputs").iterdir()) == ["a.tsv", "b.tsv"]
    # the run's own out/ holds its report (checked on disk; the API never shows the path)
    assert (run_dir / "out" / "report.json").is_file()
    assert (run_dir / "store").is_dir()


def _server_paths():
    from services import harmonize_storage

    home = harmonize_storage.HARMONIZE_HOME
    return {str(p) for root in (runs_root(), harmonize_storage.jobs_home(), home)
            for p in (root, root.resolve())}


def test_no_server_path_in_status_report_or_review_bodies(client, finished_job):
    bodies = [
        client.get(f"/harmonize/runs/{finished_job}", headers=U1).text,
        client.get("/harmonize/runs", headers=U1).text,
        client.get(f"/harmonize/runs/{finished_job}/report", headers=U1).text,
        client.get(f"/harmonize/runs/{finished_job}/review-items", headers=U1).text,
        client.get(f"/harmonize/runs/{finished_job}/review-items/l-lactate", headers=U1).text,
        client.post(f"/harmonize/runs/{finished_job}/cancel", headers=U1).text,
    ]
    for body in bodies:
        for path in _server_paths():
            assert path not in body


def test_job_error_message_has_home_prefix_removed(client, two_files, spec_two, monkeypatch):
    import routes.harmonize as harmonize_routes

    leaked = runs_root() / "abc" / "inputs" / "a.tsv"
    monkeypatch.setattr(harmonize_routes, "get_backend",
                        lambda: _CapBackend(f"{leaked} has no rows with a value in 'name'."))
    r = client.post("/harmonize/cohorts", files=two_files, data={"spec": json.dumps(spec_two)}, headers=U1)
    assert r.status_code == 400
    assert r.json()["detail"] == "runs/abc/inputs/a.tsv has no rows with a value in 'name'."


class _SpyBackend:
    """Delegates to the real backend and records cancel calls."""

    def __init__(self, inner):
        self.inner = inner
        self.cancelled = []

    def __getattr__(self, name):
        return getattr(self.inner, name)

    async def cancel(self, job_id):
        self.cancelled.append(job_id)
        return await self.inner.cancel(job_id)


def test_insert_failure_cancels_job_and_cleans_up(slow_client, two_files, spec_two, monkeypatch):
    import routes.harmonize as harmonize_routes
    from services import harmonize_backend
    from services.database import database

    spy = _SpyBackend(harmonize_backend.get_backend())
    monkeypatch.setattr(harmonize_routes, "get_backend", lambda: spy)

    async def broken_insert(**kwargs):
        raise RuntimeError("database is locked")

    monkeypatch.setattr(database, "insert_harmonize_run", broken_insert)
    with pytest.raises(RuntimeError, match="database is locked"):
        slow_client.post("/harmonize/cohorts", files=two_files,
                         data={"spec": json.dumps(spec_two)}, headers=U1)
    assert len(spy.cancelled) == 1
    assert list(runs_root().iterdir()) == []


def test_many_submit_runs(client, spec_many):
    files = [("files", ("a.tsv", A_TSV, "text/plain")), ("files", ("b.tsv", B_TSV, "text/plain")),
             ("files", ("c.csv", C_CSV, "text/csv"))]
    r = client.post("/harmonize/many", files=files, data={"spec": json.dumps(spec_many)}, headers=U1)
    assert r.status_code == 200, r.text
    st = wait_complete(client, r.json()["jobId"], U1)
    assert st["kind"] == "harmonize_many"
    assert st["labels"] == ["a", "b", "c"]
    rep = client.get(f"/harmonize/runs/{st['jobId']}/report", headers=U1).json()
    assert rep["kind"] == "harmonize_many"


def test_many_rejects_one_file_and_thirteen(client, spec_many):
    for n in (1, 13):
        spec = {**spec_many, "cohorts": [_cohort(f"c{i}") for i in range(n)]}
        r = client.post("/harmonize/many", files=many_files(n),
                        data={"spec": json.dumps(spec)}, headers=U1)
        assert r.status_code == 400, (n, r.text)
        assert r.json()["detail"]
    assert client.get("/harmonize/runs", headers=U1).json() == []
    assert not runs_root().exists() or list(runs_root().iterdir()) == []


def test_many_rejects_file_count_not_matching_cohorts(client, spec_many):
    r = client.post("/harmonize/many", files=many_files(2),
                    data={"spec": json.dumps(spec_many)}, headers=U1)
    assert r.status_code == 400
    assert "3" in r.json()["detail"] and "2" in r.json()["detail"]


@pytest.mark.parametrize("bad", [b"", b"\xef\xbb\xbfwrong\tcols\n1\t2\n"])
def test_malformed_file_is_400_and_no_run(client, bad, spec_two):
    r = client.post("/harmonize/cohorts", files=files_with_a(bad), data={"spec": json.dumps(spec_two)}, headers=U1)
    assert r.status_code == 400 and r.json()["detail"]
    assert client.get("/harmonize/runs", headers=U1).json() == []
    assert list(runs_root().iterdir()) == []


def test_missing_column_message_names_file_and_columns(client, spec_two):
    r = client.post("/harmonize/cohorts", files=files_with_a(b"wrong\tcols\n1\t2\n"),
                    data={"spec": json.dumps(spec_two)}, headers=U1)
    assert r.status_code == 400
    assert r.json()["detail"] == "Column 'name' is not in file 'a.tsv'. Columns found: wrong, cols."


def test_missing_vocabulary_column_is_400(client, spec_two):
    spec = {**spec_two, "b": {**_cohort("b"), "vocabularies": {"HMDB": ["hmdb_id"]}}}
    r = client.post("/harmonize/cohorts", files=files_with_a(A_TSV),
                    data={"spec": json.dumps(spec)}, headers=U1)
    assert r.status_code == 400
    assert "'hmdb_id'" in r.json()["detail"] and "'b.tsv'" in r.json()["detail"]
    assert list(runs_root().iterdir()) == []


def test_duplicate_labels_rejected_before_saving(client, two_files, spec_two):
    spec = {**spec_two, "b": _cohort("a")}
    r = client.post("/harmonize/cohorts", files=two_files, data={"spec": json.dumps(spec)}, headers=U1)
    assert r.status_code == 400
    assert "distinct" in r.json()["detail"].lower()
    assert not runs_root().exists() or list(runs_root().iterdir()) == []


@pytest.mark.parametrize("label", ["n_links", "links_by_basis"])
def test_reserved_label_rejected_before_saving_on_cohort_runs(client, two_files, spec_two, label):
    spec = {**spec_two, "b": _cohort(label)}
    r = client.post("/harmonize/cohorts", files=two_files, data={"spec": json.dumps(spec)}, headers=U1)
    assert r.status_code == 400
    assert r.json()["detail"] == f"The label '{label}' is reserved. Choose a different label."
    assert not runs_root().exists() or list(runs_root().iterdir()) == []


@pytest.mark.parametrize("label", ["n_links", "node", "Clean"])
def test_reserved_label_rejected_on_many_cohort_runs(client, spec_many, label):
    spec = {**spec_many, "cohorts": [_cohort("a"), _cohort("b"), _cohort(label)]}
    r = client.post("/harmonize/many", files=many_files(3), data={"spec": json.dumps(spec)},
                    headers=U1)
    assert r.status_code == 400
    assert r.json()["detail"] == f"The label '{label}' is reserved. Choose a different label."
    assert not runs_root().exists() or list(runs_root().iterdir()) == []


def test_bad_label_rejected_before_saving(client, two_files, spec_two):
    spec = {**spec_two, "b": _cohort("")}
    r = client.post("/harmonize/cohorts", files=two_files, data={"spec": json.dumps(spec)}, headers=U1)
    assert r.status_code == 400
    assert r.json()["detail"] == "Cohort label '' can only use letters, digits, '.', '-' and '_'."
    assert not runs_root().exists() or list(runs_root().iterdir()) == []


@pytest.mark.parametrize("spec", ["not json", json.dumps({"entity": "metabolites"}),
                                  json.dumps({"entity": "m", "a": _cohort("a"),
                                              "b": {**_cohort("b"), "extra": 1}})])
def test_bad_spec_is_400(client, two_files, spec):
    r = client.post("/harmonize/cohorts", files=two_files, data={"spec": spec}, headers=U1)
    assert r.status_code == 400 and r.json()["detail"]
    assert not runs_root().exists() or list(runs_root().iterdir()) == []


def test_queue_full_is_409_and_cleans_up(client_with_cap_backend, two_files, spec_two):
    r = client_with_cap_backend.post("/harmonize/cohorts", files=two_files, data={"spec": json.dumps(spec_two)}, headers=U1)
    assert r.status_code == 409 and "job" in r.json()["detail"].lower()
    assert list(runs_root().iterdir()) == []
    assert client_with_cap_backend.get("/harmonize/runs", headers=U1).json() == []


def test_other_job_error_is_400_with_message_passed_through(client, two_files, spec_two,
                                                            monkeypatch):
    import routes.harmonize as harmonize_routes

    msg = "a.tsv has 20001 rows; a harmonize job takes at most 20000 rows per cohort file."
    monkeypatch.setattr(harmonize_routes, "get_backend", lambda: _CapBackend(msg))
    r = client.post("/harmonize/cohorts", files=two_files, data={"spec": json.dumps(spec_two)}, headers=U1)
    assert r.status_code == 400 and r.json()["detail"] == msg
    assert list(runs_root().iterdir()) == []


def test_example_is_400_until_installed(client, tmp_path, monkeypatch):
    import routes.harmonize as harmonize_routes

    monkeypatch.setattr(harmonize_routes, "EXAMPLES_DIR", tmp_path / "no_examples")
    r = client.post("/harmonize/example", json={"kind": "two_cohort"}, headers=U1)
    assert r.status_code == 400
    assert r.json()["detail"] == "The example dataset is not installed."


# -- ownership and auth ------------------------------------------------------


def test_missing_user_header_is_400(client, finished_job, two_files, spec_two):
    for method, path in [("get", "/harmonize/runs"), ("get", f"/harmonize/runs/{finished_job}"),
                         ("get", f"/harmonize/runs/{finished_job}/report"),
                         ("post", f"/harmonize/runs/{finished_job}/cancel")]:
        r = getattr(client, method)(path)
        assert r.status_code == 400, path
        assert r.json()["detail"] == "Missing x-clerk-user-id header"
    r = client.post("/harmonize/cohorts", files=two_files, data={"spec": json.dumps(spec_two)})
    assert r.status_code == 400
    assert len(list(runs_root().iterdir())) == 1  # only finished_job's


def test_other_user_gets_404_everywhere(client, finished_job):
    for path in ["", "/report", "/review-items", "/review-items/r-glucose"]:
        assert client.get(f"/harmonize/runs/{finished_job}{path}", headers=U2).status_code == 404
    for action in ("cancel", "resume"):
        assert client.post(f"/harmonize/runs/{finished_job}/{action}", headers=U2).status_code == 404
    assert client.get("/harmonize/runs", headers=U2).json() == []


def test_unknown_run_is_404(client):
    assert client.get("/harmonize/runs/nope", headers=U1).status_code == 404


# -- listing, lifecycle, review items ----------------------------------------


def test_list_runs_newest_first_with_status(client, two_files, spec_two):
    jobs = []
    for _ in range(2):
        r = client.post("/harmonize/cohorts", files=two_files,
                        data={"spec": json.dumps(spec_two)}, headers=U1)
        jobs.append(r.json()["jobId"])
        wait_complete(client, jobs[-1], U1)
    runs = client.get("/harmonize/runs", headers=U1).json()
    assert [r["jobId"] for r in runs] == list(reversed(jobs))
    assert all(r["state"] == "complete" and r["labels"] == ["a", "b"] for r in runs)


def test_report_is_409_until_finished_then_cancel_and_resume(slow_client, two_files, spec_two):
    r = slow_client.post("/harmonize/cohorts", files=two_files,
                         data={"spec": json.dumps(spec_two)}, headers=U1)
    job = r.json()["jobId"]
    assert r.json()["state"] == "queued"
    rep = slow_client.get(f"/harmonize/runs/{job}/report", headers=U1)
    assert rep.status_code == 409 and rep.json()["detail"]
    items = slow_client.get(f"/harmonize/runs/{job}/review-items", headers=U1)
    assert items.status_code == 409
    cancelled = slow_client.post(f"/harmonize/runs/{job}/cancel", headers=U1)
    assert cancelled.status_code == 200 and cancelled.json()["state"] == "cancelled"
    assert cancelled.json()["labels"] == ["a", "b"]
    resumed = slow_client.post(f"/harmonize/runs/{job}/resume", headers=U1)
    assert resumed.status_code == 200 and resumed.json()["state"] == "queued"
    slow_client.post(f"/harmonize/runs/{job}/cancel", headers=U1)


def test_review_items_page_and_detail(client, finished_job):
    page = client.get(f"/harmonize/runs/{finished_job}/review-items",
                      params={"kind": "row", "limit": 10}, headers=U1)
    assert page.status_code == 200
    body = page.json()
    assert body["jobId"] == finished_job and body["total"] == 1 and body["limit"] == 10
    assert body["counts"] == {"row": 1, "link": 1}
    assert body["nextOffset"] is None and "skippedNoNode" in body
    item = body["items"][0]
    assert item["ref"] == "r-glucose" and item["nRows"] == 2 and "engineChoice" in item

    detail = client.get(f"/harmonize/runs/{finished_job}/review-items/l-lactate", headers=U1)
    assert detail.status_code == 200
    link = detail.json()["link"]
    assert detail.json()["nextStep"] and link["linkKind"] == "two_cohort"
    # data-keyed maps keep their keys
    assert link["a"]["identifiers"] == {"HMDB": ["HMDB0000122"]}
    assert link["a"]["certificateStates"] == {"corroborated": 1}
    assert link["a"]["nodeName"] == "D-glucose"


def test_review_items_bad_paging_is_400(client, finished_job):
    r = client.get(f"/harmonize/runs/{finished_job}/review-items", params={"limit": 51}, headers=U1)
    assert r.status_code == 400 and "limit" in r.json()["detail"]
    r = client.get(f"/harmonize/runs/{finished_job}/review-items/nope", headers=U1)
    assert r.status_code == 400 and "nope" in r.json()["detail"]


# -- inspect ------------------------------------------------------------------


def test_inspect_returns_columns(client):
    data = b"\xef\xbb\xbfname\thmdb\nGlucose\tHMDB0000122\nLactate\tHMDB0000190\n"
    r = client.post("/harmonize/inspect", files={"file": ("a.tsv", data, "text/plain")}, headers=U1)
    assert r.status_code == 200
    assert r.json() == {"columns": ["name", "hmdb"], "rowCount": 2}
    assert not runs_root().exists() or list(runs_root().iterdir()) == []


def test_inspect_csv_and_bad_file(client):
    r = client.post("/harmonize/inspect", files={"file": ("c.txt", C_CSV, "text/plain")}, headers=U1)
    assert r.json() == {"columns": ["name", "hmdb"], "rowCount": 1}
    r = client.post("/harmonize/inspect", files={"file": ("c.xlsx", C_CSV, "text/plain")}, headers=U1)
    assert r.status_code == 400 and "xlsx" in r.json()["detail"]
