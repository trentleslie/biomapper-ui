"""Gold-set conformance + scorer reproducibility (plan Unit 2).

The built-in HMDB gold set is a committed snapshot derived from
``biomapper_ui_test_dataset.csv`` (curated ``provided_ids`` relabeled to ``gt_hmdb``,
tiered by ``match_level`` with CURATION as the headline). The scorer must reproduce the
hand-scored expectation without the live SDK.
"""
import csv
import json
from pathlib import Path

from services.scorer import Category, score_row

_DATA = Path(__file__).resolve().parent.parent / "data"
_GOLD = _DATA / "hmdb_gold_set.csv"
_EXPECT = _DATA / "hmdb_gold_expectation.json"


def _load_gold():
    with open(_GOLD, newline="") as f:
        return list(csv.DictReader(f))


def test_gold_set_wide_format_and_tiers():
    rows = _load_gold()
    assert rows, "gold set is empty"
    assert set(rows[0].keys()) == {"name", "gt_hmdb", "match_level"}
    expect = json.load(open(_EXPECT))
    counts = expect["counts"]
    assert len(rows) == counts["total"]
    curation = [r for r in rows if r["match_level"] == "CURATION"]
    ms2 = [r for r in rows if r["match_level"] == "MS2"]
    assert len(curation) == counts["curation"]
    assert len(ms2) == counts["ms2"]
    # Every gt_hmdb cell is a non-empty ';'-joined set of HMDB ids.
    for r in rows:
        ids = r["gt_hmdb"].split(";")
        assert ids and all(i.startswith("HMDB") for i in ids)


def test_scorer_reproduces_expectation():
    expect = json.load(open(_EXPECT))
    for case in expect["cases"]:
        result = {"identifiers": {"hmdb": case["returned_hmdb"]}, "kgEquivalentIds": {}}
        row = score_row(case["name"], "hmdb", case["gt_hmdb"], result)
        assert row.category is Category(case["expect_category"]), case["name"]
        assert list(row.hit_ranks) == case["expect_hit_ranks"], case["name"]
