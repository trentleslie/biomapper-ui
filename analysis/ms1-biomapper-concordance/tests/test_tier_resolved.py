"""Tests: tier-resolved concordance (per HMDB *source* tier, set-overlap vs Biomapper)."""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import tier_resolved as TR  # noqa: E402


# --- tier_state (set-overlap) ---

def test_tier_state():
    assert TR.tier_state({"A"}, {"A"}) == TR.CONCORDANT
    assert TR.tier_state({"A", "B"}, {"B"}) == TR.CONCORDANT       # any overlap
    assert TR.tier_state({"A"}, {"B"}) == TR.DISAGREE
    assert TR.tier_state({"A"}, set()) == TR.NO_BIOMAPPER          # tier has id, biomapper empty
    assert TR.tier_state(set(), {"A"}) == TR.NO_TIER              # feature lacks this tier's HMDB
    assert TR.tier_state(set(), set()) == TR.NO_TIER


# --- best-tier rollup (group_ms2 > ms2 > ms1) ---

def test_best_tier_prefers_highest():
    tiers = {"ms1": {"A"}, "ms2": {"B"}, "group_ms2": {"C"}}
    assert TR.best_tier(tiers) == ("group_ms2", {"C"})
    assert TR.best_tier({"ms1": {"A"}, "ms2": {"B"}, "group_ms2": set()}) == ("ms2", {"B"})
    assert TR.best_tier({"ms1": {"A"}, "ms2": set(), "group_ms2": set()}) == ("ms1", {"A"})
    assert TR.best_tier({"ms1": set(), "ms2": set(), "group_ms2": set()}) == (None, set())


# --- per-feature per-tier extraction from the xlsx ---

def _write_xlsx(path):
    with pd.ExcelWriter(path) as xw:
        pd.DataFrame([
            # feature 1: same HMDB at MS1 and MS2 (matches biomapper) -> concordant at both tiers
            {"feature_id": "1", "matched_name": "Glucose",
             "ms1_compound_name": "HMDB:HMDB00122-9 Beta-D-Glucose",
             "ms2_compound_name": "HMDB:HMDB00122-1 D-Glucose",
             "group_ms2_compound_name": "", "curation_compound_name": "internalX"},
            # feature 2: MS1 disagrees, MS2 agrees with biomapper -> cross-tier resolved
            {"feature_id": "2", "matched_name": "Sarcosine",
             "ms1_compound_name": "HMDB:HMDB00013-1 D-Alanine",
             "ms2_compound_name": "HMDB:HMDB00271-1 Sarcosine",
             "group_ms2_compound_name": "HMDB:HMDB00271-2 Sarcosine",
             "curation_compound_name": ""},
            # feature 3: only MS1, disagrees with biomapper
            {"feature_id": "3", "matched_name": "Orphan",
             "ms1_compound_name": "HMDB:HMDB00999-9 Mystery",
             "ms2_compound_name": "", "group_ms2_compound_name": "",
             "curation_compound_name": ""},
        ]).to_excel(xw, sheet_name="M1", index=False)
        # second method sheet: feature 1 reappears, adds a group_ms2 HMDB -> unioned across sheets
        pd.DataFrame([
            {"feature_id": "1", "matched_name": "Glucose",
             "ms1_compound_name": "", "ms2_compound_name": "",
             "group_ms2_compound_name": "HMDB:HMDB00122-3 Glucose",
             "curation_compound_name": ""},
        ]).to_excel(xw, sheet_name="M2", index=False)


def test_build_tier_hmdb_by_feature(tmp_path):
    p = tmp_path / "x.xlsx"; _write_xlsx(p)
    by = TR.build_tier_hmdb_by_feature(p)
    assert by["1"]["ms1"] == {"HMDB0000122"}
    assert by["1"]["ms2"] == {"HMDB0000122"}
    assert by["1"]["group_ms2"] == {"HMDB0000122"}     # unioned in from the 2nd sheet
    assert by["2"]["ms1"] == {"HMDB0000013"}
    assert by["2"]["group_ms2"] == {"HMDB0000271"}
    assert by["3"]["ms2"] == set()


# --- column augmentation + summary on a comprehensive-shaped frame ---

def _comprehensive(tmp_path):
    """Minimal comprehensive-shaped frame: feature_id + per-feature biomapper id set."""
    p = tmp_path / "x.xlsx"; _write_xlsx(p)
    comp = pd.DataFrame([
        {"feature_id": "1", "matched_name": "Glucose", "bmap_hmdb": "HMDB0000122"},
        {"feature_id": "2", "matched_name": "Sarcosine", "bmap_hmdb": "HMDB0000271"},
        {"feature_id": "3", "matched_name": "Orphan", "bmap_hmdb": "HMDB0000271"},
    ])
    return comp, p


def test_add_tier_columns(tmp_path):
    comp, p = _comprehensive(tmp_path)
    out = TR.add_tier_columns(comp, p)
    by = {r["feature_id"]: r for _, r in out.iterrows()}
    # feature 1: concordant at every tier it carries
    assert by["1"]["ms1_state"] == TR.CONCORDANT
    assert by["1"]["ms2_state"] == TR.CONCORDANT
    assert by["1"]["group_ms2_state"] == TR.CONCORDANT
    assert by["1"]["best_tier"] == "group_ms2" and by["1"]["best_tier_state"] == TR.CONCORDANT
    # feature 2: MS1 disagrees, higher tiers agree -> best-tier resolves it
    assert by["2"]["ms1_state"] == TR.DISAGREE
    assert by["2"]["ms2_state"] == TR.CONCORDANT
    assert by["2"]["best_tier"] == "group_ms2" and by["2"]["best_tier_state"] == TR.CONCORDANT
    assert by["2"]["best_tier_hmdb"] == "HMDB0000271"
    # feature 3: only MS1, disagrees; higher tiers absent
    assert by["3"]["ms1_state"] == TR.DISAGREE
    assert by["3"]["ms2_state"] == TR.NO_TIER
    assert by["3"]["best_tier"] == "ms1"


def test_tier_summary_and_cross_tier(tmp_path):
    comp, p = _comprehensive(tmp_path)
    out = TR.add_tier_columns(comp, p)
    summary = TR.tier_summary(out)
    s = {r["tier"]: r for _, r in summary.iterrows()}
    # MS1: features 1,2,3 carry an MS1 HMDB; all biomapper-comparable; 1 concordant (f1), 2 disagree
    assert s["ms1"]["with_hmdb"] == 3 and s["ms1"]["comparable"] == 3
    assert s["ms1"]["concordant"] == 1 and s["ms1"]["disagree"] == 2
    assert s["ms1"]["concordance_pct"] == 33
    # MS2: features 1,2 carry an MS2 HMDB, both concordant
    assert s["ms2"]["with_hmdb"] == 2 and s["ms2"]["concordant"] == 2 and s["ms2"]["disagree"] == 0
    assert s["ms2"]["concordance_pct"] == 100
    # cross-tier: feature 2 has MS1 + a higher tier; MS1 disagrees but higher agrees
    x = TR.cross_tier_resolved(out)
    assert x["both_ms1_and_higher"] == 2     # features 1 and 2 carry MS1 and a higher tier
    assert x["ms1_disagree_higher_agree"] == 1   # only feature 2


# --- guide HTML injection (idempotent, anchored after the call-tier FAQ) ---

def test_inject_guide_section_idempotent(tmp_path):
    comp, p = _comprehensive(tmp_path)
    out = TR.add_tier_columns(comp, p)
    summary, cross = TR.tier_summary(out), TR.cross_tier_resolved(out)
    section = TR.tier_section_html(summary, cross)
    guide = ('<h2>Guide</h2>\n<div class="faq" id="tier">\n<h4>2. call tier</h4>\n</div>\n'
             '\n<div class="faq">\n<h4>3. next</h4>\n</div>\n')
    once = TR.inject_guide_section(guide, section)
    twice = TR.inject_guide_section(once, section)
    assert once.count('id="source-tier"') == 1
    assert once == twice                                   # re-running never duplicates/accretes
    assert once.index('id="source-tier"') > once.index('id="tier"')   # inserted AFTER call-tier FAQ
    assert once.index('id="source-tier"') < once.index('3. next')     # and BEFORE the following FAQ
