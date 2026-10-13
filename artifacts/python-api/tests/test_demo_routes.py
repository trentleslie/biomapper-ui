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
    # Same rule as the loader: first occurrence of each non-empty name decides its category.
    expected_categories: dict[str, int] = {}
    seen: set[str] = set()
    for r in rows:
        name = r["compound_name"].strip()
        if name and name not in seen:
            seen.add(name)
            category = r["issue_category"].strip() or "Uncategorized"
            expected_categories[category] = expected_categories.get(category, 0) + 1

    res = _client().get("/map/demo")

    assert res.status_code == 200
    body = res.json()
    assert body["count"] == len(seen)
    assert body["categories"] == expected_categories
    assert "Uncategorized" not in body["categories"]
    assert body["entity_type"] == "biolink:SmallMolecule"


def test_demo_info_unavailable_when_dataset_failed(monkeypatch):
    monkeypatch.setattr(demo, "_demo_error", "boom")

    res = _client().get("/map/demo")

    assert res.status_code == 503
