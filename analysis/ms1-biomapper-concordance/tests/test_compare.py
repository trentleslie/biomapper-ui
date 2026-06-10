"""Unit 3 tests: classification, RefMet bridge, CSV sanitization, join."""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import compare as C  # noqa: E402


# --- classify ---

def test_classify_exact():
    assert C.classify({"15971"}, {"15971"}) == C.AGREE_EXACT


def test_classify_partial_multi_id():
    assert C.classify({"15971"}, {"15971", "44637"}) == C.AGREE_PARTIAL


def test_classify_disagree():
    assert C.classify({"15971"}, {"99999"}) == C.DISAGREE


def test_classify_new_and_missed_and_none():
    assert C.classify(set(), {"1"}) == C.NEW_COVERAGE
    assert C.classify({"1"}, set()) == C.MISSED
    assert C.classify(set(), set()) == C.NONE


# --- RefMet bridge ---

def test_refmet_bridge_unavailable_marks_rows():
    bridge = C.RefMetBridge(None)
    assert not bridge.available
    assert bridge.classify_feature("L-Histidine", {"RM0129894"}) == C.BRIDGE_UNAVAILABLE


def test_refmet_bridge_from_file(tmp_path):
    p = tmp_path / "refmet.csv"
    pd.DataFrame({"refmet_id": ["RM0129894"], "refmet_name": ["Histidine"]}).to_csv(p, index=False)
    bridge = C.RefMetBridge.from_data_dir(tmp_path)
    assert bridge.available
    # the reference name "Histidine" vs Biomapper refmet id resolved to "Histidine" -> exact
    assert bridge.classify_feature("Histidine", {"RM0129894"}) == C.AGREE_EXACT
    # mismatched name -> disagree
    assert bridge.classify_feature("Glucose", {"RM0129894"}) == C.DISAGREE


# --- sanitize ---

def test_sanitize_cell():
    assert C.sanitize_cell("=cmd()") == "'=cmd()"
    assert C.sanitize_cell("-2") == "'-2"
    assert C.sanitize_cell("+x") == "'+x"
    assert C.sanitize_cell("@x") == "'@x"
    assert C.sanitize_cell("Glucose") == "Glucose"


# --- compare (join + classification end-to-end) ---

def _feature_df():
    return pd.DataFrame({
        "feature_id": ["1", "2", "2", "3"],
        "matched_name": ["Glucose", "Taurine", "Taurine alt", "MysteryLipid"],
        "match_level": ["CURATION", "MS2", "MS2", "MS1"],
        "hmdb_id": ["HMDB0000122", "HMDB0000251", "NA", "NA"],
        "chebi_id": ["17234", "NA", "NA", "NA"],
        "kegg_id": ["NA", "NA", "NA", "NA"],
        "lipidmaps_id": ["NA", "NA", "NA", "LMFA01030036"],
        "pubchem_cid": ["NA", "NA", "NA", "NA"],
        "refmet_name": ["Glucose", "NA", "NA", "NA"],
    })


def _name_only_results():
    return [
        # Glucose: HMDB agrees exact, CHEBI new (reference has chebi too -> agree), refmet via bridge
        {"query_name": "Glucose", "resolved": True, "confidence_tier": "high",
         "primary_curie": "CHEBI:17234",
         "identifiers": {"CHEBI": ["17234"], "refmet_id": ["RM0135901"]},
         "kg_equivalent_ids": {"HMDB": ["HMDB0000122"]}, "error": None},
        # Taurine: HMDB disagree (different id)
        {"query_name": "Taurine", "resolved": True, "confidence_tier": "high",
         "primary_curie": "CHEBI:1", "identifiers": {},
         "kg_equivalent_ids": {"HMDB": ["HMDB9999999"]}, "error": None},
        # Taurine alt: unresolved
        {"query_name": "Taurine alt", "resolved": False, "confidence_tier": "unknown",
         "primary_curie": None, "identifiers": {}, "kg_equivalent_ids": {}, "error": None},
        # MysteryLipid: LipidMaps new_coverage via kg['LM'] (LM-prefix reconciliation)
        {"query_name": "MysteryLipid", "resolved": True, "confidence_tier": "low",
         "primary_curie": "LM:FA01030036", "identifiers": {},
         "kg_equivalent_ids": {"LM": ["FA01030036"]}, "error": None},
    ]


def test_compare_classifications():
    df = _feature_df()
    out = C.compare(df, _name_only_results(), hinted=None, bridge=C.RefMetBridge(None))
    by = {(r["feature_id"], r["matched_name"]): r for _, r in out.iterrows()}

    # duplicate feature_id=2 yields two rows on distinct names
    assert ("2", "Taurine") in by and ("2", "Taurine alt") in by
    assert len(out) == 4

    glucose = by[("1", "Glucose")]
    assert glucose["HMDB__class"] == C.AGREE_EXACT
    assert glucose["CHEBI__class"] == C.AGREE_EXACT

    taurine = by[("2", "Taurine")]
    assert taurine["HMDB__class"] == C.DISAGREE

    alt = by[("2", "Taurine alt")]
    assert alt["resolved"] is False
    assert alt["HMDB__class"] == C.MISSED or alt["HMDB__class"] == C.NONE  # reference NA here -> none

    lipid = by[("3", "MysteryLipid")]
    assert lipid["LIPIDMAPS__class"] == C.AGREE_EXACT  # reference LMFA01030036 vs kg LM FA01030036
    assert lipid["LIPIDMAPS__card"] == 1


def test_compare_refmet_bridge_unavailable_column():
    df = _feature_df()
    out = C.compare(df, _name_only_results(), hinted=None, bridge=C.RefMetBridge(None))
    assert (out["refmet__class"] == C.BRIDGE_UNAVAILABLE).all()


def test_write_comparison_sanitizes(tmp_path):
    df = pd.DataFrame({
        "feature_id": ["1"], "matched_name": ["=DANGER()"], "match_level": ["MS1"],
        "HMDB__class": ["none"],
    })
    p = tmp_path / "out.csv"
    C.write_comparison(df, p)
    text = p.read_text()
    assert "'=DANGER()" in text


def test_mapped_final_preserves_originals_and_appends():
    df = _feature_df()
    out = C.build_mapped_final(df, _name_only_results())
    for col in df.columns:                       # every original column preserved
        assert col in out.columns
    for col in ["hmdb_id", "chebi_id", "kegg_id", "lipidmaps_id", "pubchem_cid"]:
        assert f"{col}_biomapper" in out.columns  # appended parallel to originals
    assert {"resolved_biomapper", "primary_curie_biomapper",
            "confidence_tier_biomapper", "refmet_id_biomapper"} <= set(out.columns)
    assert len(out) == len(df)                    # row count unchanged
    glucose = out[out["matched_name"] == "Glucose"].iloc[0]
    assert glucose["hmdb_id"] == "HMDB0000122"            # original untouched
    assert glucose["hmdb_id_biomapper"] == "HMDB0000122"  # biomapper mapping appended
    assert bool(glucose["resolved_biomapper"])


def test_write_mapped_final_sanitizes(tmp_path):
    df = pd.DataFrame({"matched_name": ["=EVIL()"], "hmdb_id_biomapper": ["HMDB0000001"]})
    p = tmp_path / "mapped.csv"
    C.write_mapped_final(df, p)
    assert "'=EVIL()" in p.read_text()
