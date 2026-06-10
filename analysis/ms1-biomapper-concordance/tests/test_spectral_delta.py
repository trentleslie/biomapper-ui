"""Unit 1/5 tests: feature-grain extraction, three-way classify, delta, relation, export."""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import spectral_delta as SD  # noqa: E402


# --- classify_three_way ---

def test_classify_states():
    assert SD.classify_three_way({"A"}, {"A"}, {"A"}) == SD.ALL_AGREE
    assert SD.classify_three_way({"X"}, {"A"}, {"A"}) == SD.SPECTRAL_DISAGREES
    assert SD.classify_three_way({"A"}, {"X"}, {"A"}) == SD.BIOMAPPER_DISAGREES
    assert SD.classify_three_way({"X"}, {"X"}, {"A"}) == SD.CURATION_OUTLIER  # spectral==bmap != curated
    assert SD.classify_three_way({"X"}, {"Y"}, {"A"}) == SD.ALL_DIFFER
    assert SD.classify_three_way({"X"}, {"Y"}, set()) == SD.NO_ARBITER


# --- feature-grain extraction + build_spectral_delta ---

def _write_xlsx(path):
    with pd.ExcelWriter(path) as xw:
        pd.DataFrame([
            {"feature_id": "1", "matched_name": "Glucose",
             "ms1_compound_name": "HMDB:HMDB00122-9 Beta-D-Glucose", "ms2_compound_name": "",
             "ms1_cosine_score": "0.95"},
            # same name, different feature_id + different embedded HMDB across a sheet
            {"feature_id": "2", "matched_name": "Mystery",
             "ms1_compound_name": "HMDB:HMDB00001-1 Wrongate", "ms2_compound_name": "",
             "ms1_cosine_score": "0.40"},
        ]).to_excel(xw, sheet_name="Method1", index=False)
        pd.DataFrame([
            {"feature_id": "1", "matched_name": "Glucose",
             "ms1_compound_name": "HMDB:HMDB00999-9 Glucose-alt", "ms2_compound_name": "",
             "ms1_cosine_score": "0.80"},  # feature 1 carries a 2nd embedded HMDB → multiplicity
        ]).to_excel(xw, sheet_name="Method2", index=False)


def test_build_embedded_by_feature_preserves_multiplicity(tmp_path):
    p = tmp_path / "x.xlsx"; _write_xlsx(p)
    emb = SD.build_embedded_by_feature(p)
    assert set(emb["1"]["hmdb"]) == {"HMDB0000122", "HMDB0000999"}   # both kept, not collapsed
    assert emb["1"]["hmdb"]["HMDB0000122"]["cosine"] == 0.95
    assert set(emb["2"]["hmdb"]) == {"HMDB0000001"}


def _comp_gt():
    comp = pd.DataFrame([
        {"matched_name": "Glucose", "HMDB__bmap": "HMDB0000122", "HMDB__ref": "HMDB0000122",
         "confidence_tier": "high"},
        {"matched_name": "Mystery", "HMDB__bmap": "HMDB0009999", "HMDB__ref": "HMDB0009999",
         "confidence_tier": "low"},
    ])
    gt = pd.DataFrame([
        {"feature_id": "1", "matched_name": "Glucose", "match_level": "CURATION",
         "curation_chemical_id": "1235", "refmet_name": "Glucose"},
        {"feature_id": "2", "matched_name": "Mystery", "match_level": "MS1",
         "curation_chemical_id": "NA", "refmet_name": "NA"},
    ])
    return comp, gt


def test_build_spectral_delta_join_and_states(tmp_path):
    p = tmp_path / "x.xlsx"; _write_xlsx(p)
    comp, gt = _comp_gt()
    delta = SD.build_spectral_delta(comp, gt, p)
    by_fid = {r["feature_id"]: r for _, r in delta.iterrows()}
    assert set(by_fid) == {"1", "2"}
    # feature 1: spectral {122,999}, curated {122} -> spectral overlaps curated -> all-agree
    assert by_fid["1"]["three_way_state"] == SD.ALL_AGREE
    assert by_fid["1"]["spectral_n"] == 2 and by_fid["1"]["rep_spectral_id"] == "HMDB0000122"  # top cosine
    # feature 2: spectral {1}, bmap/curated {9999} -> spectral disagrees
    assert by_fid["2"]["three_way_state"] == SD.SPECTRAL_DISAGREES
    assert by_fid["2"]["curation_xref_present"] is False  # curation_chemical_id NA


def test_enrich_and_export_with_provisional_marker(tmp_path):
    p = tmp_path / "x.xlsx"; _write_xlsx(p)
    comp, gt = _comp_gt()
    delta = SD.build_spectral_delta(comp, gt, p)
    meta = {
        "HMDB0000001": {"name": "Wrongate", "formula": "C2H6O", "monoisotopic_mass": "46.04",
                        "inchikey": "BBBB-X-N", "link": "l", "source": "mw"},
        "HMDB0009999": {"name": "Mystery true", "formula": "C9H9", "monoisotopic_mass": "117.07",
                        "inchikey": "AAAA-X-N", "link": "l", "source": "mw"},
    }
    enriched = SD.enrich_with_relation(delta, meta)
    assert "structural_relation" in enriched.columns
    out = SD.build_metabolon_export(enriched, meta)
    assert "spectral_name" in out.columns and "llm_cause" in out.columns
    exp = tmp_path / "export.csv"
    SD.write_metabolon_export(out, exp)
    text = exp.read_text()
    assert text.startswith("# PROVISIONAL")          # marker present by default
    assert "Wrongate" in text
