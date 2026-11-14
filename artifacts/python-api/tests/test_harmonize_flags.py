"""Items and organizer flags routes, on replay runs whose report.json is a real package report."""
import json
import time

import pytest
from fastapi.testclient import TestClient

from biomapper.jobs import FINISHED_STATES

U1 = {"x-clerk-user-id": "user-1"}
U2 = {"x-clerk-user-id": "user-2"}

A_TSV = b"name\thmdb\nGlucose\tHMDB0000122\n"
SPEC_TWO = {"entity": "metabolites",
            "a": {"label": "a", "nameColumn": "name"}, "b": {"label": "b", "nameColumn": "name"}}
SPEC_MANY = {"entity": "metabolites",
             "cohorts": [{"label": x, "nameColumn": "name"} for x in ("a", "b", "c")]}


@pytest.fixture
def app_factory(tmp_path, monkeypatch, real_recording_dir):
    """Build a TestClient over one database file; each call is a fresh app process state."""
    from services.database import database

    monkeypatch.setenv("BIOMAPPER_HARMONIZE_REPLAY_DIR", str(real_recording_dir))
    monkeypatch.setattr(database, "_path", tmp_path / "harmonize_flags.db")
    from main import app

    return lambda: TestClient(app)


@pytest.fixture(autouse=True)
def _fresh_items_cache():
    from routes.harmonize import clear_items_cache

    clear_items_cache()
    yield
    clear_items_cache()


@pytest.fixture
def client(app_factory):
    with app_factory() as c:
        yield c


def wait_complete(client, job, timeout_s=30.0):
    deadline = time.monotonic() + timeout_s
    while True:
        st = client.get(f"/harmonize/runs/{job}", headers=U1).json()
        if st["state"] in FINISHED_STATES:
            return st
        assert time.monotonic() < deadline, f"run {job} still {st['state']}"
        time.sleep(0.02)


def submit_two(client):
    files = {"fileA": ("a.tsv", A_TSV, "text/tab-separated-values"),
             "fileB": ("b.tsv", A_TSV, "text/tab-separated-values")}
    r = client.post("/harmonize/cohorts", files=files, data={"spec": json.dumps(SPEC_TWO)},
                    headers=U1)
    assert r.status_code == 200, r.text
    return r.json()["jobId"]


@pytest.fixture
def finished_job(client):
    job = submit_two(client)
    wait_complete(client, job)
    return job


def items(client, job, headers=U1, **params):
    r = client.get(f"/harmonize/runs/{job}/items", params={"limit": 1000, **params},
                   headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def first_item(client, job, suggested):
    return next(i for i in items(client, job)["items"] if i["suggested"] is suggested)


def get_item(client, job, ref):
    return next(i for i in items(client, job)["items"] if i["ref"] == ref)


def test_items_list_shape(client, finished_job, two_cohort_report):
    from services.harmonize_items import items_from_report

    body = items(client, finished_job)
    expected = items_from_report(two_cohort_report)
    assert body["total"] == len(expected) == len(body["items"])
    assert body["flaggedTotal"] == sum(i.suggested for i in expected)
    it = body["items"][0]
    assert set(it) == {"ref", "kind", "arm", "members", "detail", "suggested", "flagged",
                       "source"}
    assert [i["ref"] for i in body["items"]] == [i.ref for i in expected]
    assert all(i["flagged"] == i["suggested"] and i["source"] == "biomapper"
               for i in body["items"])
    link = next(i for i in body["items"] if i["kind"] == "link")
    assert {"oneToOne", "basis", "ambiguous", "reviewReasons", "origin"} <= set(link["detail"])
    assert set(link["members"][0]) == {"cohort", "key", "name", "chosenKgId"}


def test_items_filters_and_paging(client, finished_job):
    every = items(client, finished_job)["items"]
    links = items(client, finished_job, kind="link", arm="identifier")
    assert links["total"] == 3 and {(i["kind"], i["arm"]) for i in links["items"]} == {
        ("link", "identifier")}
    flagged = items(client, finished_job, flagged="true")
    assert flagged["total"] == sum(i["flagged"] for i in every)
    page = items(client, finished_job, offset=2, limit=3)
    assert page["total"] == len(every)
    assert [i["ref"] for i in page["items"]] == [i["ref"] for i in every[2:5]]


def test_deflag_a_suggestion_then_reset(client, finished_job):
    ref = first_item(client, finished_job, suggested=True)["ref"]
    r = client.put(f"/harmonize/runs/{finished_job}/flags", json={"refs": [ref], "flagged": False},
                   headers=U1)
    assert r.status_code == 200, r.text
    before = items(client, finished_job)["flaggedTotal"]
    assert r.json() == {"updated": 1, "flaggedTotal": before}
    it = get_item(client, finished_job, ref)
    assert (it["flagged"], it["source"]) == (False, "organizer")
    r = client.post(f"/harmonize/runs/{finished_job}/flags/reset", json={"refs": [ref]},
                    headers=U1)
    assert r.status_code == 200 and r.json() == {"flaggedTotal": before + 1}
    it = get_item(client, finished_job, ref)
    assert (it["flagged"], it["source"]) == (True, "biomapper")


def test_setting_back_to_suggested_removes_the_override(client, finished_job):
    ref = first_item(client, finished_job, suggested=False)["ref"]
    url = f"/harmonize/runs/{finished_job}/flags"
    client.put(url, json={"refs": [ref], "flagged": True}, headers=U1)
    assert get_item(client, finished_job, ref)["source"] == "organizer"
    client.put(url, json={"refs": [ref], "flagged": False}, headers=U1)
    it = get_item(client, finished_job, ref)
    assert (it["flagged"], it["source"]) == (False, "biomapper")


def test_reset_without_refs_clears_every_override(client, finished_job):
    body = items(client, finished_job)
    suggested_total = body["flaggedTotal"]
    refs = [i["ref"] for i in body["items"]]
    client.put(f"/harmonize/runs/{finished_job}/flags", json={"refs": refs, "flagged": True},
               headers=U1)
    assert items(client, finished_job)["flaggedTotal"] == len(refs)
    r = client.post(f"/harmonize/runs/{finished_job}/flags/reset", json={}, headers=U1)
    assert r.json() == {"flaggedTotal": suggested_total}
    assert all(i["source"] == "biomapper" for i in items(client, finished_job)["items"])


class _ReportOnlyBackend:
    """After a restart the replay backend has forgotten its jobs; this one still has the report."""

    def __init__(self, report):
        self.report = report

    def load_report(self, job_id):
        return self.report


def test_flags_are_per_user_and_survive_restart(app_factory, two_cohort_report, monkeypatch):
    with app_factory() as c:
        job = submit_two(c)
        wait_complete(c, job)
        ref = first_item(c, job, suggested=False)["ref"]
        r = c.put(f"/harmonize/runs/{job}/flags", json={"refs": [ref], "flagged": True},
                  headers=U1)
        assert r.status_code == 200

    from services.database import database

    async def flags_of(user):
        return await database.list_harmonize_flags(job, user)

    import routes.harmonize as harmonize_routes

    # A new process: no cached items, and a backend that only knows the report.
    harmonize_routes.clear_items_cache()
    monkeypatch.setattr(harmonize_routes, "get_backend",
                        lambda: _ReportOnlyBackend(two_cohort_report))
    with app_factory() as c:
        it = get_item(c, job, ref)
        assert (it["flagged"], it["source"]) == (True, "organizer")
        assert c.portal.call(flags_of, "user-1") == {ref: True}
        # Another user cannot see the run, and a write from them stores nothing for anyone.
        assert c.get(f"/harmonize/runs/{job}/items", headers=U2).status_code == 404
        r = c.put(f"/harmonize/runs/{job}/flags", json={"refs": [ref], "flagged": False},
                  headers=U2)
        assert r.status_code == 404
        assert c.portal.call(flags_of, "user-2") == {}
        assert c.portal.call(flags_of, "user-1") == {ref: True}


def test_bulk_flag_by_filter_counts(client, finished_job):
    every = items(client, finished_job)["items"]
    url = f"/harmonize/runs/{finished_job}/flags/bulk"
    r = client.post(url, json={"filter": {"kind": "link", "arm": "names_only",
                                          "ambiguous": False}, "flagged": True}, headers=U1)
    assert r.status_code == 200, r.text
    plain = [i for i in every if i["kind"] == "link" and i["arm"] == "names_only"
             and not i["detail"]["ambiguous"]]
    base = sum(i["flagged"] for i in every)
    assert r.json() == {"updated": len(plain), "flaggedTotal": base + len(plain)}
    r = client.post(url, json={"filter": {"kind": "link"}, "flagged": False}, headers=U1)
    links = [i for i in every if i["kind"] == "link"]
    assert r.json()["updated"] == len(links)
    assert r.json()["flaggedTotal"] == sum(i["flagged"] for i in every if i["kind"] != "link")
    r = client.post(url, json={"filter": {"basis": "node"}, "flagged": True}, headers=U1)
    assert r.json()["updated"] == sum(i["detail"].get("basis") == "node" for i in every)
    for it in items(client, finished_job, kind="link")["items"]:
        assert it["flagged"] is True
        assert it["source"] == ("biomapper" if it["suggested"] else "organizer")


def test_unknown_ref_is_400(client, finished_job):
    good = first_item(client, finished_job, suggested=False)["ref"]
    r = client.put(f"/harmonize/runs/{finished_job}/flags",
                   json={"refs": [good, "link:names_only:nope"], "flagged": True}, headers=U1)
    assert r.status_code == 400 and "link:names_only:nope" in r.json()["detail"]
    assert get_item(client, finished_job, good)["source"] == "biomapper"  # nothing written
    r = client.post(f"/harmonize/runs/{finished_job}/flags/reset",
                    json={"refs": ["review:identifier:zzz"]}, headers=U1)
    assert r.status_code == 400 and "review:identifier:zzz" in r.json()["detail"]


def test_flag_routes_404_for_other_user(client, finished_job):
    ref = first_item(client, finished_job, suggested=True)["ref"]
    base = f"/harmonize/runs/{finished_job}"
    assert client.get(f"{base}/items", headers=U2).status_code == 404
    assert client.put(f"{base}/flags", json={"refs": [ref], "flagged": False},
                      headers=U2).status_code == 404
    assert client.post(f"{base}/flags/bulk", json={"filter": {}, "flagged": False},
                       headers=U2).status_code == 404
    assert client.post(f"{base}/flags/reset", json={}, headers=U2).status_code == 404
    assert get_item(client, finished_job, ref)["source"] == "biomapper"


def test_flag_routes_need_user_header(client, finished_job):
    base = f"/harmonize/runs/{finished_job}"
    assert client.get(f"{base}/items").status_code == 400
    assert client.put(f"{base}/flags", json={"refs": [], "flagged": True}).status_code == 400
    assert client.post(f"{base}/flags/bulk", json={"filter": {}, "flagged": True}).status_code == 400
    assert client.post(f"{base}/flags/reset", json={}).status_code == 400


def test_items_409_until_finished(tmp_path, monkeypatch, real_recording_dir):
    from services.database import database

    monkeypatch.setenv("BIOMAPPER_HARMONIZE_REPLAY_DIR", str(real_recording_dir))
    monkeypatch.setenv("BIOMAPPER_HARMONIZE_REPLAY_PACE", "5")
    monkeypatch.setattr(database, "_path", tmp_path / "slow.db")
    from main import app

    import routes.harmonize as harmonize_routes

    with TestClient(app) as c:
        job = submit_two(c)
        base = f"/harmonize/runs/{job}"
        assert c.get(f"{base}/items", headers=U1).status_code == 409
        assert c.put(f"{base}/flags", json={"refs": [], "flagged": True},
                     headers=U1).status_code == 409
        assert c.post(f"{base}/flags/bulk", json={"filter": {}, "flagged": True},
                      headers=U1).status_code == 409
        assert c.post(f"{base}/flags/reset", json={}, headers=U1).status_code == 409
        assert job not in harmonize_routes._items_cache  # nothing cached for an unfinished run


def test_many_cohort_run_items(client):
    job = submit_many(client)
    body = items(client, job)
    assert {i["kind"] for i in body["items"]} == {"group", "review", "unresolved"}
    group = next(i for i in body["items"] if i["kind"] == "group" and i["detail"]["multiplicity"])
    assert group["suggested"] is True
    # rows_per_cohort is keyed by cohort labels: kept as written, not camel-cased.
    assert set(group["detail"]["rowsPerCohort"]) == {"a", "b"}
    r = client.post(f"/harmonize/runs/{job}/flags/bulk",
                    json={"filter": {"kind": "group"}, "flagged": True}, headers=U1)
    assert r.json()["updated"] == sum(i["kind"] == "group" for i in body["items"])


def submit_many(client):
    files = [("files", (f"c{i}.tsv", A_TSV, "text/tab-separated-values")) for i in range(3)]
    r = client.post("/harmonize/many", files=files, data={"spec": json.dumps(SPEC_MANY)},
                    headers=U1)
    assert r.status_code == 200, r.text
    job = r.json()["jobId"]
    wait_complete(client, job)
    return job


def test_ref_from_another_run_is_400(client, finished_job):
    many_job = submit_many(client)
    group_ref = next(i["ref"] for i in items(client, many_job)["items"] if i["kind"] == "group")
    r = client.put(f"/harmonize/runs/{finished_job}/flags",
                   json={"refs": [group_ref], "flagged": True}, headers=U1)
    assert r.status_code == 400 and group_ref in r.json()["detail"]


def test_unknown_ref_message_names_at_most_ten(client, finished_job):
    refs = [f"link:names_only:bad{n:02d}" for n in range(13)]
    r = client.put(f"/harmonize/runs/{finished_job}/flags", json={"refs": refs, "flagged": True},
                   headers=U1)
    detail = r.json()["detail"]
    assert r.status_code == 400
    assert all(ref in detail for ref in refs[:10]) and "bad10" not in detail
    assert detail.endswith("and 3 more.")


def test_items_are_built_once_per_finished_run(client, finished_job, monkeypatch):
    import routes.harmonize as harmonize_routes

    real = harmonize_routes.get_backend()
    calls = []

    class Counting:
        def load_report(self, job_id):
            calls.append(job_id)
            return real.load_report(job_id)

        async def status(self, job_id):
            return await real.status(job_id)

    monkeypatch.setattr(harmonize_routes, "get_backend", lambda: Counting())
    ref = items(client, finished_job)["items"][0]["ref"]
    items(client, finished_job, kind="link")
    client.put(f"/harmonize/runs/{finished_job}/flags", json={"refs": [ref], "flagged": True},
               headers=U1)
    client.post(f"/harmonize/runs/{finished_job}/flags/reset", json={}, headers=U1)
    assert calls == [finished_job]


def test_items_cache_is_bounded(client):
    import routes.harmonize as harmonize_routes

    jobs = [submit_two(client) for _ in range(harmonize_routes.ITEMS_CACHE_RUNS + 1)]
    for job in jobs:
        wait_complete(client, job)
        items(client, job)
    assert list(harmonize_routes._items_cache) == jobs[1:]
