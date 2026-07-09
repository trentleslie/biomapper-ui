"""Tests: curated-free two-way spectral<->Biomapper comparison (state, relation, localization, export)."""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import two_way as TW  # noqa: E402


# --- two_way_state ---

def test_two_way_state():
    assert TW.two_way_state({"A"}, {"A"}) == TW.CONCORDANT
    assert TW.two_way_state({"A", "B"}, {"B"}) == TW.CONCORDANT      # any overlap
    assert TW.two_way_state({"A"}, {"B"}) == TW.DISAGREE
    assert TW.two_way_state({"A"}, set()) == TW.NO_BIOMAPPER
    assert TW.two_way_state(set(), {"A"}) == TW.NO_SPECTRAL


# --- name_match_hint (weak, string-only) ---

def test_name_match_hint():
    assert TW.name_match_hint("Sarcosine", "sarcosine") == TW.NAME_EXACT
    assert TW.name_match_hint("Citric acid", "citric acid anhydrous") == TW.NAME_FUZZY  # Jaccard 2/3
    assert TW.name_match_hint("Glycine", "trimethylamine N-oxide") == TW.NAME_NONE
    assert TW.name_match_hint(None, "anything") == TW.NAME_NO_META


# --- deterministic fault localization ---

def test_localize():
    # biomapper name reproduces matched_name, spectral does not -> upstream name-derivation broke
    assert TW.localize(TW.NAME_NONE, TW.NAME_EXACT) == TW.FAULT_NAME_DERIVATION
    # spectral name reproduces matched_name, biomapper does not -> biomapper drifted
    assert TW.localize(TW.NAME_EXACT, TW.NAME_NONE) == TW.FAULT_BIOMAPPER
    # both match (synonyms) -> id-synonym, not a real fault
    assert TW.localize(TW.NAME_EXACT, TW.NAME_FUZZY) == TW.FAULT_ID_SYNONYM
    # neither matches -> defer to LLM
    assert TW.localize(TW.NAME_NONE, TW.NAME_NONE) == TW.FAULT_BOTH_DRIFT
    # missing metadata on a side -> undetermined
    assert TW.localize(TW.NAME_NO_META, TW.NAME_EXACT) == TW.FAULT_UNDETERMINED


# --- build_two_way + enrichment + export ---

def _write_xlsx(path):
    with pd.ExcelWriter(path) as xw:
        pd.DataFrame([
            {"feature_id": "1", "matched_name": "sarcosine",
             "ms1_compound_name": "HMDB:HMDB00013-10 D-Alanine", "ms2_compound_name": "",
             "ms1_cosine_score": "0.95", "mean_mz": "90.05", "adduct_type": "[M+H]+"},
            {"feature_id": "2", "matched_name": "Glucose",
             "ms1_compound_name": "HMDB:HMDB00122-9 Beta-D-Glucose", "ms2_compound_name": "",
             "ms1_cosine_score": "0.99"},
            {"feature_id": "3", "matched_name": "Orphan",
             "ms1_compound_name": "HMDB:HMDB00999-9 Mystery", "ms2_compound_name": "",
             "ms1_cosine_score": "0.5"},
        ]).to_excel(xw, sheet_name="M1", index=False)


def _comp():
    # name-grain biomapper mappings (HMDB__bmap), joined on matched_name
    return pd.DataFrame([
        {"matched_name": "sarcosine", "HMDB__bmap": "HMDB0000271", "confidence_tier": "high"},  # disagree
        {"matched_name": "Glucose", "HMDB__bmap": "HMDB0000122", "confidence_tier": "high"},     # concordant
        {"matched_name": "Orphan", "HMDB__bmap": "", "confidence_tier": "low"},                  # no biomapper id
    ])


def test_build_two_way_states_and_multiplicity(tmp_path):
    p = tmp_path / "x.xlsx"; _write_xlsx(p)
    delta = TW.build_two_way(_comp(), p)
    by = {r["feature_id"]: r for _, r in delta.iterrows()}
    assert by["1"]["two_way_state"] == TW.DISAGREE
    assert by["1"]["rep_spectral_id"] == "HMDB0000013" and by["1"]["rep_bmap_id"] == "HMDB0000271"
    assert by["2"]["two_way_state"] == TW.CONCORDANT and by["2"]["agreeing_ids"] == "HMDB0000122"
    assert by["3"]["two_way_state"] == TW.NO_BIOMAPPER


def test_enrich_and_export(tmp_path):
    p = tmp_path / "x.xlsx"; _write_xlsx(p)
    delta = TW.build_two_way(_comp(), p)
    meta = {
        "HMDB0000013": {"name": "D-Alanine", "formula": "C3H7NO2", "monoisotopic_mass": "89.0477",
                        "inchikey": "QNAYBMKLOCPYGJ-UWTATZPHSA-N", "link": "l", "source": "mw"},
        "HMDB0000271": {"name": "Sarcosine", "formula": "C3H7NO2", "monoisotopic_mass": "89.0477",
                        "inchikey": "FSYKKLYZXJSNPZ-UHFFFAOYSA-N", "link": "l", "source": "mw"},
        "HMDB0000122": {"name": "Glucose", "formula": "C6H12O6", "monoisotopic_mass": "180.063",
                        "inchikey": "WQZGKKKJIJFFOK-GASJEMHNSA-N", "link": "l", "source": "mw"},
    }
    enriched = TW.enrich_with_relation(delta, meta)
    by = {r["feature_id"]: r for _, r in enriched.iterrows()}
    # D-Alanine vs Sarcosine: same formula, different InChIKey -> isomer
    assert by["1"]["structural_relation"] == "isomer"
    # biomapper name 'Sarcosine' == matched_name 'sarcosine'; spectral 'D-Alanine' != -> name_derivation
    assert by["1"]["bmap_name_hint"] == TW.NAME_EXACT
    assert by["1"]["fault_locus_deterministic"] == TW.FAULT_NAME_DERIVATION

    out = TW.build_export(enriched, meta)
    assert {"spectral_name", "bmap_name", "llm_fault_locus", "llm_recommended_id"} <= set(out.columns)
    exp = tmp_path / "two_way.csv"
    TW.write_export(out, exp)
    text = exp.read_text()
    assert text.startswith("# PROVISIONAL")
    assert "Sarcosine" in text and "D-Alanine" in text
