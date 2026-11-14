"""Finished-jobs mode: harmonize two finished mapping jobs offline with biomapper's harmonize().

Service tests build stored rows the way services/mapper.py stores them. Route tests insert
mapping jobs straight into the jobs table; a from-jobs run never calls the harmonize backend.
"""
import functools
import itertools
import json

import pytest
from fastapi.testclient import TestClient

from services.harmonize_offline import (
    REMAP_MESSAGE,
    StaleMappingJobError,
    harmonize_finished_jobs,
    to_mapping_result,
)
from tests.harmonize_fixtures import make_results_report

U1 = {"x-clerk-user-id": "user-1"}
U2 = {"x-clerk-user-id": "user-2"}

_nodes = itertools.count(1)


def row(name, equivalents, *, node=None, **extra):
    """A stored mapping-job result row as services/mapper.py writes it.

    Each row gets its own chosen node unless one is given, so two rows only link through a
    shared identifier (or a name, when asked).
    """
    chosen = node or f"TEST:{next(_nodes)}"
    out = {"name": name, "resolved": True, "primaryCurie": chosen, "confidenceScore": 0.9,
           "confidenceTier": "high", "maxAnnotatorScore": 0.9, "reviewReason": None,
           "chosenKgIdReview": None, "needsReview": False, "identifiers": {},
           "kgEquivalentIds": equivalents, "chosenKgId": chosen, "certificateState": None,
           "nameIsMixture": None, "providedIds": {}}
    out.update(extra)
    return out


def unresolved(name):
    return {"name": name, "resolved": False, "primaryCurie": None, "confidenceScore": None,
            "confidenceTier": "unknown", "maxAnnotatorScore": None, "reviewReason": None,
            "chosenKgIdReview": None, "needsReview": True, "identifiers": {},
            "kgEquivalentIds": {}, "chosenKgId": None, "certificateState": None,
            "nameIsMixture": None, "providedIds": {}}


def errored(name):
    return {"name": name, "resolved": False, "error": "boom", "error_type": "mapping_error",
            "kgEquivalentIds": {}, "providedIds": {}}


def job(results, *, entity_type="biolink:SmallMolecule", status="complete"):
    return {"status": status, "results": results,
            "config": {"entity_type": entity_type, "annotation_mode": "missing"}}


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


def test_two_jobs_link_on_shared_identifier():
    rep = harmonize_finished_jobs(job([row("Glucose", {"HMDB": ["HMDB0000122"]})]),
                                  job([row("D-glucose", {"HMDB": ["HMDB0000122"]})]),
                                  a_label="a", b_label="b", link_by_name=False)
    links = rep["arms"]["names_only"]["links"]
    assert len(links) == 1 and links[0]["basis"] in {"node", "identifier"}


def test_name_link_only_when_asked():
    a, b = job([row("Compound X", {})]), job([row("Compound X", {})])
    assert harmonize_finished_jobs(a, b, a_label="a", b_label="b", link_by_name=False)["arms"]["names_only"]["links"] == []
    assert len(harmonize_finished_jobs(a, b, a_label="a", b_label="b", link_by_name=True)["arms"]["names_only"]["links"]) == 1


def test_same_chosen_node_links_on_node_basis():
    rep = harmonize_finished_jobs(job([row("Glucose", {}, node="CHEBI:4167")]),
                                  job([row("glucose", {}, node="CHEBI:4167")]),
                                  a_label="a", b_label="b", link_by_name=False)
    assert [lk["basis"] for lk in rep["arms"]["names_only"]["links"]] == ["node"]


def test_wrapper_shape_matches_the_results_report(results_report):
    rep = harmonize_finished_jobs(job([row("Glucose", {})]), job([row("D-Glucose", {})]),
                                  a_label="a", b_label="b", link_by_name=True)
    assert rep["schema_version"] == 1 and rep["kind"] == "harmonize_results"
    assert rep["labels"] == ["a", "b"]
    assert rep["arms"]["identifier"] is None
    assert set(rep["arms"]["names_only"]) == set(results_report["arms"]["names_only"])
    assert rep["name_linking"]["enabled"] is True
    assert rep["name_linking"]["decided_by"] == "user"
    assert rep["name_linking"]["overridable"] is True
    assert rep["name_linking"]["reason"]
    assert rep["entity"] == "biolink:SmallMolecule"
    json.dumps(rep)  # report.json takes it as is


def test_unresolved_and_errored_rows_are_kept_apart():
    rep = harmonize_finished_jobs(job([unresolved("Mystery"), errored("Broken")]),
                                  job([row("X", {})]), a_label="a", b_label="b",
                                  link_by_name=False)
    arm = rep["arms"]["names_only"]
    assert arm["unresolved"]["a"] == ["Mystery"]
    assert arm["errors"]["a"] == ["Broken"]


def test_contradicted_certificate_and_mixture_reach_possible_missed():
    a = job([row("Thing", {}, certificateState="contradicted"),
             row("Other", {}, nameIsMixture=True)])
    rep = harmonize_finished_jobs(a, job([row("Y", {})]), a_label="a", b_label="b",
                                  link_by_name=False)
    reasons = {m["key"]: m["reasons"] for m in rep["arms"]["names_only"]["possible_missed"]}
    assert reasons == {"Thing": ["certificate_contradicted"], "Other": ["mixture"]}


def test_to_mapping_result_rebuilds_what_harmonize_reads():
    result = to_mapping_result(row("Glucose", {"HMDB": ["HMDB0000122"]}, node="CHEBI:4167",
                                   primaryCurie="RM:1", chosenKgIdReview="divergent_refmet",
                                   certificateState="contradicted", nameIsMixture=True))
    assert result.query_name == "Glucose"
    assert result.chosen_kg_id == "CHEBI:4167"
    assert result.primary_curie == "RM:1"
    assert result.kg_equivalent_ids == {"HMDB": ["HMDB0000122"]}
    assert result.chosen_kg_id_review == "divergent_refmet"
    assert result.certificate.state == "contradicted"
    assert result.name_is_mixture is True
    assert result.error is None


def test_to_mapping_result_keeps_an_error():
    assert to_mapping_result(errored("Broken")).error == "boom"


def test_row_mapped_before_the_change_is_refused():
    old = row("Glucose", {})
    for key in ("chosenKgId", "certificateState", "nameIsMixture"):
        old.pop(key)
    with pytest.raises(StaleMappingJobError) as exc:
        to_mapping_result(old)
    assert str(exc.value) == REMAP_MESSAGE


def test_duplicate_names_are_refused_readably():
    with pytest.raises(ValueError, match="more than once"):
        harmonize_finished_jobs(job([row("A", {}), row("A", {})]), job([row("B", {})]),
                                a_label="a", b_label="b", link_by_name=False)


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------


@pytest.fixture
def client(tmp_path, monkeypatch):
    from services.database import database

    monkeypatch.setattr(database, "_path", tmp_path / "harmonize_offline.db")
    from main import app

    with TestClient(app) as c:
        yield c


async def _insert(job_id, user, results, *, status="complete", entity_type="biolink:SmallMolecule"):
    from services.database import database

    await database.insert_job(job_id=job_id, user_id=user, status=status, total=len(results),
                              config={"entity_type": entity_type, "annotation_mode": "missing"})
    await database.update_job(job_id, status=status, completed=len(results), results=results)


def insert(client, *args, **kwargs):
    client.portal.call(functools.partial(_insert, *args, **kwargs))


def _body(a="ja", b="jb", **extra):
    return {"jobA": a, "jobB": b, "aLabel": "a", "bLabel": "b", "linkByName": False, **extra}


@pytest.fixture
def two_jobs(client):
    insert(client, "ja", "user-1", [row("Glucose", {"HMDB": ["HMDB0000122"]}),
                                    row("Hexose", {}, chosenKgIdReview="divergent_refmet"),
                                    unresolved("Mystery")])
    insert(client, "jb", "user-1", [row("D-glucose", {"HMDB": ["HMDB0000122"]}),
                                    errored("Broken")])
    return client


def test_route_rejects_unfinished_other_users_or_mixed_entity_type_jobs(client):
    insert(client, "mine", "user-1", [row("Glucose", {})])
    insert(client, "theirs", "user-2", [row("Glucose", {})])
    insert(client, "running", "user-1", [row("Glucose", {})], status="processing")
    insert(client, "genes", "user-1", [row("TP53", {})], entity_type="biolink:Gene")

    r = client.post("/harmonize/from-jobs", json=_body("mine", "theirs"), headers=U1)
    assert r.status_code == 404
    r = client.post("/harmonize/from-jobs", json=_body("mine", "nope"), headers=U1)
    assert r.status_code == 404
    r = client.post("/harmonize/from-jobs", json=_body("mine", "running"), headers=U1)
    assert r.status_code == 409 and "finished" in r.json()["detail"]
    r = client.post("/harmonize/from-jobs", json=_body("mine", "genes"), headers=U1)
    assert r.status_code == 400 and "entity type" in r.json()["detail"]
    r = client.post("/harmonize/from-jobs", json=_body("mine", "mine"))
    assert r.status_code == 400  # missing header
    assert client.get("/harmonize/runs", headers=U1).json() == []


def test_route_refuses_a_job_mapped_before_the_change(client):
    old = row("Glucose", {})
    for key in ("chosenKgId", "certificateState", "nameIsMixture"):
        old.pop(key)
    insert(client, "old", "user-1", [old])
    insert(client, "new", "user-1", [row("Glucose", {})])

    r = client.post("/harmonize/from-jobs", json=_body("old", "new"), headers=U1)

    assert r.status_code == 400
    assert r.json()["detail"] == ("This job was mapped before harmonizing finished jobs was "
                                  "supported. Map the file again, then harmonize.")


def test_route_refuses_equal_labels(two_jobs):
    r = two_jobs.post("/harmonize/from-jobs", json=_body(bLabel="a"), headers=U1)
    assert r.status_code == 400
    assert r.json()["detail"] == "Cohort labels must be distinct (got a, a)."


@pytest.mark.parametrize("label", ["", " ", "a b", "line\nbreak", "=SUM(A1)"])
def test_route_refuses_labels_outside_the_cohort_rule(two_jobs, label):
    r = two_jobs.post("/harmonize/from-jobs", json=_body(aLabel=label), headers=U1)
    assert r.status_code == 400
    assert r.json()["detail"] == (f"Cohort label {label!r} can only use letters, digits, '.', "
                                  "'-' and '_'.")
    assert two_jobs.get("/harmonize/runs", headers=U1).json() == []


@pytest.mark.parametrize("label", ["n_links", "n_needs_review"])
def test_route_refuses_a_reserved_label_readably(two_jobs, label):
    r = two_jobs.post("/harmonize/from-jobs", json=_body(bLabel=label), headers=U1)
    assert r.status_code == 400
    assert r.json()["detail"] == f"The label '{label}' is reserved. Choose a different label."
    assert two_jobs.get("/harmonize/runs", headers=U1).json() == []


def test_from_jobs_run_is_served_from_disk(two_jobs, monkeypatch):
    from services import harmonize_backend

    r = two_jobs.post("/harmonize/from-jobs", json=_body(), headers=U1)
    assert r.status_code == 200, r.text
    status = r.json()
    job_id = status["jobId"]
    assert status["state"] == "complete" and status["kind"] == "harmonize_results"
    assert status["labels"] == ["a", "b"] and status["entity"] == "biolink:SmallMolecule"
    assert status["cohorts"] == [{"label": "a", "rows": 3}, {"label": "b", "rows": 2}]
    assert status["rowsErrored"] == 1

    # Nothing below may reach the job runner.
    def no_backend():
        raise AssertionError("a from-jobs run must not ask the backend")

    monkeypatch.setattr(harmonize_backend, "get_backend", no_backend)
    import routes.harmonize as routes

    monkeypatch.setattr(routes, "get_backend", no_backend)

    assert two_jobs.get(f"/harmonize/runs/{job_id}", headers=U1).json() == status
    assert two_jobs.get("/harmonize/runs", headers=U1).json() == [status]
    report = two_jobs.get(f"/harmonize/runs/{job_id}/report", headers=U1).json()
    assert report["kind"] == "harmonize_results"
    assert [lk["basis"] for lk in report["arms"]["names_only"]["links"]] == ["identifier"]

    for action in ("resume", "cancel"):
        r = two_jobs.post(f"/harmonize/runs/{job_id}/{action}", headers=U1)
        assert r.status_code == 409 and "finished mapping jobs" in r.json()["detail"]

    page = two_jobs.get(f"/harmonize/runs/{job_id}/review-items", headers=U1).json()
    assert page["total"] == 0 and page["items"] == [] and page["jobId"] == job_id
    page = two_jobs.get(f"/harmonize/runs/{job_id}/review-items",
                        params={"kind": "link", "offset": -3, "limit": -1}, headers=U1).json()
    assert page["total"] == 0 and page["offset"] == 0 and page["limit"] == 1
    page = two_jobs.get(f"/harmonize/runs/{job_id}/review-items", params={"limit": 999},
                        headers=U1).json()
    assert page["limit"] == 50
    r = two_jobs.get(f"/harmonize/runs/{job_id}/review-items/x", headers=U1)
    assert r.status_code == 400

    # Another user sees none of it.
    assert two_jobs.get(f"/harmonize/runs/{job_id}", headers=U2).status_code == 404
    assert two_jobs.get(f"/harmonize/runs/{job_id}/report", headers=U2).status_code == 404


def test_from_jobs_run_has_items_flags_and_exports(two_jobs):
    job_id = two_jobs.post("/harmonize/from-jobs", json=_body(), headers=U1).json()["jobId"]

    items = two_jobs.get(f"/harmonize/runs/{job_id}/items", headers=U1).json()
    kinds = sorted(i["kind"] for i in items["items"])
    assert kinds == ["link", "review", "unresolved", "unresolved"]

    ref = next(i["ref"] for i in items["items"] if i["kind"] == "link")
    r = two_jobs.put(f"/harmonize/runs/{job_id}/flags", json={"refs": [ref], "flagged": True},
                     headers=U1)
    assert r.status_code == 200

    r = two_jobs.get(f"/harmonize/runs/{job_id}/export",
                     params={"table": "links", "format": "csv"}, headers=U1)
    assert r.status_code == 200
    lines = r.text.strip().splitlines()
    assert len(lines) == 2 and "Glucose" in lines[1]


def test_no_server_path_reaches_the_client(two_jobs):
    from services.harmonize_storage import HARMONIZE_HOME, runs_root

    status = two_jobs.post("/harmonize/from-jobs", json=_body(), headers=U1).json()
    job_id = status["jobId"]
    bodies = [json.dumps(status),
              two_jobs.get(f"/harmonize/runs/{job_id}", headers=U1).text,
              two_jobs.get(f"/harmonize/runs/{job_id}/report", headers=U1).text]
    assert not any(str(HARMONIZE_HOME) in b for b in bodies)
    assert (runs_root() / status["jobId"] / "out" / "report.json").is_file()


def test_report_on_disk_matches_fixture_shape(two_jobs):
    """Same top-level keys as the package-generated results_report fixture (plus entity)."""
    job_id = two_jobs.post("/harmonize/from-jobs", json=_body(), headers=U1).json()["jobId"]
    report = two_jobs.get(f"/harmonize/runs/{job_id}/report", headers=U1).json()
    assert set(report) == set(make_results_report()) | {"entity"}
