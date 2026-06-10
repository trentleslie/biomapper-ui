"""Unit 3 tests: deterministic structural relation."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import structural_relation as sr  # noqa: E402


def _m(inchikey=None, formula=None, mass=None, source="mw"):
    return {"inchikey": inchikey, "formula": formula, "monoisotopic_mass": mass, "source": source}


def test_same_structure_by_inchikey_block():
    a = _m("WQZGKKKJIJFFOK-VFUOTHLCSA-N", "C6H12O6", "180.06")
    b = _m("WQZGKKKJIJFFOK-DVKNGEFBSA-N", "C6H12O6", "180.06")  # same skeleton block, diff stereo
    assert sr.relation(a, b) == sr.SAME_STRUCTURE


def test_isomer_same_formula_diff_structure():
    a = _m("AAAAAAAAAAAAAA-X-N", "C7H11N3O2", "169.085")
    b = _m("BBBBBBBBBBBBBB-Y-N", "C7H11N3O2", "169.085")
    assert sr.relation(a, b) == sr.ISOMER


def test_isobaric_diff_formula_close_mass_same_source():
    a = _m("AAAAAAAAAAAAAA-X-N", "C6H12O6", "180.0634", source="mw")
    b = _m("BBBBBBBBBBBBBB-Y-N", "C5H8N2O5", "180.0590", source="mw")  # within 0.05 Da
    assert sr.relation(a, b) == sr.ISOBARIC


def test_isobar_refused_cross_source():
    a = _m("AAAAAAAAAAAAAA-X-N", "C6H12O6", "180.0634", source="mw")
    b = _m("BBBBBBBBBBBBBB-Y-N", "C5H8N2O5", "180.0590", source="pubchem")
    assert sr.relation(a, b) == sr.UNRELATED  # cross-endpoint mass not trusted


def test_unrelated_diff_formula_far_mass():
    a = _m("AAAAAAAAAAAAAA-X-N", "C6H12O6", "180.06")
    b = _m("BBBBBBBBBBBBBB-Y-N", "C2H6O", "46.04")
    assert sr.relation(a, b) == sr.UNRELATED


def test_undetermined_missing_inchikey():
    a = _m(None, "C6H12O6", "180.06")
    b = _m("BBBBBBBBBBBBBB-Y-N", "C6H12O6", "180.06")
    assert sr.relation(a, b) == sr.UNDETERMINED_NO_META


def test_undetermined_missing_metadata():
    assert sr.relation(None, _m("X-Y-N", "CH4", "16.03")) == sr.UNDETERMINED_NO_META
