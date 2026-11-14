"""GET and PATCH /jobs/{job_id} return ``config`` with the spec's camelCase top-level keys.

Mapping jobs store ``MappingConfig.model_dump(mode="json")``, which is snake_case. The response
camelizes only the top level at the boundary: ``hints`` and ``hint_columns`` are keyed by prefix and
column name, which pass through as written. Stored rows are unchanged, so the finished-jobs harmonize
service (which reads ``entity_type`` from the row) keeps working.
"""
import functools

import pytest
from fastapi.testclient import TestClient

from tests.test_harmonize_openapi_conformance import check

U1 = {"x-clerk-user-id": "user-1"}

STORED = {
    "entity_type": "biolink:Protein",
    "annotation_mode": "all",
    "annotators": None,
    "hints": {"Glucose": {"HMDB": "HMDB0000122", "some_prefix": ["x"]}},
    "hint_columns": {"HMDB": "hmdb_id", "PUBCHEM.COMPOUND": "pub_chem"},
}


@pytest.fixture
def client(tmp_path, monkeypatch):
    from services.database import database

    monkeypatch.setattr(database, "_path", tmp_path / "jobs_config.db")
    from main import app

    with TestClient(app) as c:
        yield c


async def _insert(job_id, config):
    from services.database import database

    await database.insert_job(job_id=job_id, user_id="user-1", status="complete", total=0, config=config)


def insert(client, job_id, config):
    client.portal.call(functools.partial(_insert, job_id, config))


def _stored(client, job_id):
    from services.database import database

    return client.portal.call(functools.partial(database.get_job, job_id))


def test_get_and_patch_return_camel_top_level_keys_with_inner_keys_untouched(client):
    insert(client, "j1", STORED)
    for r in (client.get("/jobs/j1", headers=U1),
              client.patch("/jobs/j1", json={"displayName": "Panel"}, headers=U1)):
        assert r.status_code == 200
        config = r.json()["config"]
        assert config == {
            "entityType": "biolink:Protein",
            "annotationMode": "all",
            "annotators": None,
            "hints": {"Glucose": {"HMDB": "HMDB0000122", "some_prefix": ["x"]}},
            "hintColumns": {"HMDB": "hmdb_id", "PUBCHEM.COMPOUND": "pub_chem"},
        }
        assert not any("_" in k for k in config)
    # The stored row keeps its snake_case keys.
    assert _stored(client, "j1")["config"]["entity_type"] == "biolink:Protein"


def test_null_config_stays_null(client):
    insert(client, "j2", None)
    r = client.get("/jobs/j2", headers=U1)
    assert r.status_code == 200 and r.json()["config"] is None


def test_unknown_keys_do_not_500(client):
    insert(client, "j3", {"entity_type": "biolink:Gene", "legacy_flag": True, "weird": {"a_b": 1}})
    r = client.get("/jobs/j3", headers=U1)
    assert r.status_code == 200
    assert r.json()["config"] == {"entityType": "biolink:Gene", "legacyFlag": True, "weird": {"a_b": 1}}


def test_job_detail_conforms_to_the_spec(client):
    insert(client, "j4", STORED)
    check("get", "/jobs/{jobId}", client.get("/jobs/j4", headers=U1).json())
    check("patch", "/jobs/{jobId}", client.patch("/jobs/j4", json={"displayName": "x"}, headers=U1).json())
