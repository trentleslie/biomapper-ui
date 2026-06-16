"""Tests: name-grain (matched_name) concordance — best-tier set-overlap + agreement axes."""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import name_concordance as NC  # noqa: E402


# --- name_state (best-tier set-overlap) ---

def test_name_state():
    assert NC.name_state({"A"}, {"A"}) == NC.CONCORDANT
    assert NC.name_state({"A", "B"}, {"B"}) == NC.CONCORDANT       # any overlap
    assert NC.name_state({"A"}, {"B"}) == NC.DISAGREE
    assert NC.name_state({"A"}, set()) == NC.NO_BIOMAPPER          # BioMapper silent


# --- agreement_fraction (over comparable features) ---

def test_agreement_fraction():
    assert NC.agreement_fraction([NC.CONCORDANT, NC.CONCORDANT, NC.DISAGREE]) == 2 / 3
    assert NC.agreement_fraction([NC.CONCORDANT, NC.CONCORDANT]) == 1.0
    # no-bmap features are not comparable; they are excluded from the denominator
    assert NC.agreement_fraction([NC.CONCORDANT, NC.NO_BIOMAPPER]) == 1.0
    # a name with no comparable features -> None
    assert NC.agreement_fraction([NC.NO_BIOMAPPER, "no-tier-hmdb"]) is None


# --- consistency (single / unanimous / mixed, comparable only) ---

def test_consistency():
    assert NC.consistency([NC.CONCORDANT]) == NC.SINGLE
    assert NC.consistency([NC.CONCORDANT, NC.CONCORDANT, NC.CONCORDANT]) == NC.UNANIMOUS
    assert NC.consistency([NC.CONCORDANT, NC.DISAGREE]) == NC.MIXED
    # one concordant + one no-bmap -> single (computed over the 1 comparable feature, NOT mixed)
    assert NC.consistency([NC.CONCORDANT, NC.NO_BIOMAPPER]) == NC.SINGLE
    # all no-bmap -> no comparable features -> blank
    assert NC.consistency([NC.NO_BIOMAPPER, NC.NO_BIOMAPPER]) == ""


# --- build_name_concordance over a feature-grain fixture ---

def _features():
    """Feature-grain rows (one per feature) spanning several names with the key cases."""
    return pd.DataFrame([
        # name A — 3 features, DIFFERENT best-tier spectral ids, each matching BioMapper {A1,A2,A3}
        # => concordant + unanimous + agreement 1.0 but spectral_homogeneous False (the A1 id-coherence case)
        {"matched_name": "alpha", "best_tier_hmdb": "HMDB0000001", "bmap_hmdb": "HMDB0000001;HMDB0000002;HMDB0000003",
         "best_tier_state": NC.CONCORDANT, "match_level": "MS1", "comparison_scope": "MS1 (HMDB reflects call)",
         "group_character": "isomers", "group_summary": "three isomers"},
        {"matched_name": "alpha", "best_tier_hmdb": "HMDB0000002", "bmap_hmdb": "HMDB0000001;HMDB0000002;HMDB0000003",
         "best_tier_state": NC.CONCORDANT, "match_level": "MS2", "comparison_scope": "higher-tier",
         "group_character": "isomers", "group_summary": "three isomers"},
        {"matched_name": "alpha", "best_tier_hmdb": "HMDB0000003", "bmap_hmdb": "HMDB0000001;HMDB0000002;HMDB0000003",
         "best_tier_state": NC.CONCORDANT, "match_level": "MS1", "comparison_scope": "MS1 (HMDB reflects call)",
         "group_character": "isomers", "group_summary": "three isomers"},
        # name B — single feature, concordant
        {"matched_name": "beta", "best_tier_hmdb": "HMDB0000010", "bmap_hmdb": "HMDB0000010",
         "best_tier_state": NC.CONCORDANT, "match_level": "MS1", "comparison_scope": "MS1 (HMDB reflects call)",
         "group_character": "", "group_summary": ""},
        # name C — one concordant + one no-bmap feature (coverage vs disagreement, A4)
        {"matched_name": "gamma", "best_tier_hmdb": "HMDB0000020", "bmap_hmdb": "HMDB0000020",
         "best_tier_state": NC.CONCORDANT, "match_level": "MS1", "comparison_scope": "MS1 (HMDB reflects call)",
         "group_character": "", "group_summary": ""},
        {"matched_name": "gamma", "best_tier_hmdb": "HMDB0000021", "bmap_hmdb": "",
         "best_tier_state": NC.NO_BIOMAPPER, "match_level": "MS2", "comparison_scope": "higher-tier",
         "group_character": "", "group_summary": ""},
        # name D — two features, one concordant one disagree (mixed); agreement 0.5
        {"matched_name": "delta", "best_tier_hmdb": "HMDB0000030", "bmap_hmdb": "HMDB0000030",
         "best_tier_state": NC.CONCORDANT, "match_level": "MS1", "comparison_scope": "MS1 (HMDB reflects call)",
         "group_character": "mixed", "group_summary": "x"},
        {"matched_name": "delta", "best_tier_hmdb": "HMDB0000031", "bmap_hmdb": "HMDB0000030",
         "best_tier_state": NC.DISAGREE, "match_level": "MS1", "comparison_scope": "MS1 (HMDB reflects call)",
         "group_character": "mixed", "group_summary": "x"},
    ])


def test_build_name_concordance():
    out = NC.build_name_concordance(_features())
    by = {r["matched_name"]: r for _, r in out.iterrows()}
    assert len(out) == 4                                   # 4 distinct names

    a = by["alpha"]
    assert a["name_state"] == NC.CONCORDANT
    assert a["consistency"] == NC.UNANIMOUS
    assert a["agreement_fraction"] == 1.0
    assert bool(a["spectral_homogeneous"]) is False        # 3 distinct best-tier ids
    assert a["n_spectral_ids"] == 3 and a["n_features"] == 3
    assert a["n_bmap_ids"] == 3
    assert a["group_character"] == "isomers"

    b = by["beta"]
    assert b["name_state"] == NC.CONCORDANT and b["consistency"] == NC.SINGLE
    assert bool(b["spectral_homogeneous"]) is True
    assert b["group_character"] == ""                      # single-spectral name -> blank group field

    g = by["gamma"]
    assert g["consistency"] == NC.SINGLE                   # over the 1 comparable feature, not mixed
    assert g["n_no_bmap_features"] == 1 and g["n_comparable_features"] == 1
    assert g["name_state"] == NC.CONCORDANT                # spectral {20,21} overlaps bmap {20}

    d = by["delta"]
    assert d["consistency"] == NC.MIXED and d["agreement_fraction"] == 0.5
    assert d["name_state"] == NC.CONCORDANT                # union overlaps bmap (the any-match upper bound)


# --- name_summary ---

def test_name_summary():
    out = NC.build_name_concordance(_features())
    s = NC.name_summary(out)
    d = {r["metric"]: r["value"] for _, r in s.iterrows()}
    assert d["concordant"] == 4 and d["disagree"] == 0 and d["no_biomapper"] == 0
    assert d["comparable"] == 4 and d["concordance_pct"] == 100
    # alpha is unanimous-but-multi-spectral; delta has agreement_fraction < 1
    assert d["spectral_heterogeneous"] == 1                # alpha (unanimous + n_spectral_ids>1)
    assert d["agreement_lt_1"] == 1                        # delta
