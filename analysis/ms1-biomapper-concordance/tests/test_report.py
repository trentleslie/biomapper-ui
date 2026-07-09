"""Unit 4 tests: metric arithmetic, denominators, lift, edge cases."""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import compare as C  # noqa: E402
import report as R  # noqa: E402


def _comp(rows: list[dict]) -> pd.DataFrame:
    # Fill required columns with defaults so metric code never KeyErrors.
    df = pd.DataFrame(rows)
    for ns in R.ALL_NAMESPACES:
        for suffix, default in (("__class", C.NONE), ("__card", 0)):
            col = f"{ns}{suffix}"
            if col not in df.columns:
                df[col] = default
    for c, default in (("resolved", False), ("hinted_resolved", False),
                       ("confidence_tier", "unknown"), ("refmet__class", C.BRIDGE_UNAVAILABLE)):
        if c not in df.columns:
            df[c] = default
    return df


def test_agreement_rate_and_denominator():
    rows = [
        {"feature_id": "1", "matched_name": "a", "match_level": "MS2", "CHEBI__class": C.AGREE_EXACT},
        {"feature_id": "2", "matched_name": "b", "match_level": "MS2", "CHEBI__class": C.AGREE_PARTIAL},
        {"feature_id": "3", "matched_name": "c", "match_level": "MS2", "CHEBI__class": C.DISAGREE},
        {"feature_id": "4", "matched_name": "d", "match_level": "MS2", "CHEBI__class": C.NEW_COVERAGE},
        {"feature_id": "5", "matched_name": "e", "match_level": "MS2", "CHEBI__class": C.MISSED},
        {"feature_id": "6", "matched_name": "f", "match_level": "MS2", "CHEBI__class": C.NONE},
    ]
    m = R.aggregate(_comp(rows))
    chebi = m["namespaces"]["CHEBI"]
    assert chebi["comparable"] == 3            # exact + partial + disagree
    assert chebi["agree"] == 2
    assert chebi["agreement_rate"] == 2 / 3
    assert chebi["exact_rate"] == 1 / 3
    assert chebi["comparable_frac"] == 3 / 6
    assert chebi["new_coverage"] == 1
    assert chebi["missed"] == 1


def test_zero_comparable_is_none_not_zerodiv():
    rows = [{"feature_id": "1", "matched_name": "a", "match_level": "MS1",
             "CHEBI__class": C.NEW_COVERAGE}]
    m = R.aggregate(_comp(rows))
    assert m["namespaces"]["CHEBI"]["agreement_rate"] is None


def test_per_tier_stratification():
    rows = [
        {"feature_id": "1", "matched_name": "a", "match_level": "CURATION", "CHEBI__class": C.AGREE_EXACT},
        {"feature_id": "2", "matched_name": "b", "match_level": "MS1", "CHEBI__class": C.DISAGREE},
    ]
    m = R.aggregate(_comp(rows))
    assert m["by_tier"]["CHEBI"]["CURATION"]["agreement_rate"] == 1.0
    assert m["by_tier"]["CHEBI"]["MS1"]["agreement_rate"] == 0.0


def test_resolution_lift():
    rows = [
        {"feature_id": "1", "matched_name": "a", "match_level": "MS2",
         "resolved": False, "hinted_resolved": True},   # lifted
        {"feature_id": "2", "matched_name": "b", "match_level": "MS2",
         "resolved": True, "hinted_resolved": True},     # already resolved
    ]
    m = R.aggregate(_comp(rows))
    assert m["lift"]["resolution_lift"] == 1
    assert m["lift"]["name_only_resolved"] == 1
    assert m["lift"]["hinted_resolved"] == 2


def test_partial_cardinality_buckets():
    rows = [
        {"feature_id": "1", "matched_name": "a", "match_level": "MS2",
         "CHEBI__class": C.AGREE_PARTIAL, "CHEBI__card": 2},
        {"feature_id": "2", "matched_name": "b", "match_level": "MS2",
         "CHEBI__class": C.AGREE_PARTIAL, "CHEBI__card": 4},
        {"feature_id": "3", "matched_name": "c", "match_level": "MS2",
         "CHEBI__class": C.AGREE_PARTIAL, "CHEBI__card": 9},
    ]
    m = R.aggregate(_comp(rows))
    assert m["partial_cardinality"]["CHEBI"] == {"2": 1, "3-5": 1, "6+": 1}


def test_new_coverage_by_confidence():
    rows = [
        {"feature_id": "1", "matched_name": "a", "match_level": "MS2",
         "CHEBI__class": C.NEW_COVERAGE, "confidence_tier": "high"},
        {"feature_id": "2", "matched_name": "b", "match_level": "MS2",
         "CHEBI__class": C.NEW_COVERAGE, "confidence_tier": "low"},
        {"feature_id": "3", "matched_name": "c", "match_level": "MS2",
         "CHEBI__class": C.NEW_COVERAGE, "confidence_tier": "high"},
    ]
    m = R.aggregate(_comp(rows))
    assert m["new_coverage_by_conf"]["CHEBI"] == {"high": 2, "low": 1}


def test_render_markdown_smoke(tmp_path):
    rows = [{"feature_id": "1", "matched_name": "a", "match_level": "MS2",
             "CHEBI__class": C.AGREE_EXACT}]
    comp = _comp(rows)
    m = R.write_report(comp, tmp_path / "report.md", meta={"timestamp": "T", "base_url": "default"})
    text = (tmp_path / "report.md").read_text()
    assert "Concordance by namespace" in text
    assert "UNVALIDATED" in text
    assert m["namespaces"]["CHEBI"]["agreement_rate"] == 1.0
