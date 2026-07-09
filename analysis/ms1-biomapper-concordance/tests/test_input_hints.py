"""Tests for input-side hint extraction (HMDB-from-names + CAS), never from ground truth."""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import input_hints as ih  # noqa: E402


def _write_xlsx(path: Path, rows_by_sheet: dict[str, list[dict]]):
    with pd.ExcelWriter(path) as xw:
        for sheet, rows in rows_by_sheet.items():
            pd.DataFrame(rows).to_excel(xw, sheet_name=sheet, index=False)


def test_parses_hmdb_from_names_and_cas(tmp_path):
    p = tmp_path / "feats.xlsx"
    _write_xlsx(p, {"Method1": [
        {"matched_name": "Acrylamide", "ms1_compound_name": "HMDB:HMDB04296-2379 Acrylamide",
         "ms2_compound_name": "", "ms2_cas_id": "79-06-1"},
        {"matched_name": "Glycine", "ms1_compound_name": "", "ms2_compound_name": "GLYCINE",
         "ms2_cas_id": "56-40-6"},
    ]})
    hints = ih.build_input_hints(p)
    assert hints["Acrylamide"]["HMDB"] == "HMDB0004296"   # parsed + zero-padded
    assert hints["Acrylamide"]["CAS"] == "79-06-1"
    assert hints["Glycine"] == {"CAS": "56-40-6"}          # no HMDB in name -> CAS only


def test_modal_pick_across_rows_and_methods(tmp_path):
    p = tmp_path / "feats.xlsx"
    _write_xlsx(p, {
        "Method1": [
            {"matched_name": "X", "ms1_compound_name": "HMDB:HMDB0000001 X", "ms2_compound_name": "", "ms2_cas_id": "11-11-1"},
            {"matched_name": "X", "ms1_compound_name": "HMDB:HMDB0000001 X", "ms2_compound_name": "", "ms2_cas_id": "11-11-1"},
        ],
        "Method2": [
            {"matched_name": "X", "ms1_compound_name": "HMDB:HMDB0000002 X", "ms2_compound_name": "", "ms2_cas_id": "22-22-2"},
        ],
    })
    hints = ih.build_input_hints(p)
    assert hints["X"]["HMDB"] == "HMDB0000001"  # modal (2 vs 1)
    assert hints["X"]["CAS"] == "11-11-1"


def test_invalid_cas_and_missing_ignored(tmp_path):
    p = tmp_path / "feats.xlsx"
    _write_xlsx(p, {"Method1": [
        {"matched_name": "Y", "ms1_compound_name": "no id here", "ms2_compound_name": "", "ms2_cas_id": "NA"},
        {"matched_name": "Z", "ms1_compound_name": "", "ms2_compound_name": "", "ms2_cas_id": "not-a-cas"},
    ]})
    hints = ih.build_input_hints(p)
    assert "Y" not in hints   # no hint at all
    assert "Z" not in hints   # invalid CAS format rejected
