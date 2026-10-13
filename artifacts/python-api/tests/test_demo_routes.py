"""GET /map/demo describes the bundled dataset the demo page advertises."""
import csv

from fastapi import FastAPI
from fastapi.testclient import TestClient

from routes import demo


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(demo.router, prefix="/map")
    return TestClient(app)


def test_demo_info_matches_bundled_csv():
    with open(demo.DEMO_CSV_PATH, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    unique_names = {r["compound_name"].strip() for r in rows if r["compound_name"].strip()}

    res = _client().get("/map/demo")

    assert res.status_code == 200
    body = res.json()
    assert body["count"] == len(unique_names)
    assert sum(body["categories"].values()) == body["count"]
    assert body["entity_type"] == "biolink:SmallMolecule"


def test_demo_info_unavailable_when_dataset_failed(monkeypatch):
    monkeypatch.setattr(demo, "_demo_error", "boom")

    res = _client().get("/map/demo")

    assert res.status_code == 503
