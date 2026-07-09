"""Unit 2 tests: HMDB metadata resolver (MW + PubChem fallback), cached, injectable fetch."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import hmdb_api  # noqa: E402


def _mw_meta(name="Beta-D-Glucose"):
    return {"name": name, "formula": "C6H12O6", "monoisotopic_mass": "180.063390",
            "inchikey": "WQZGKKKJIJFFOK-VFUOTHLCSA-N", "pubchem_cid": "64689",
            "chebi_id": "15903", "kegg_id": "C00221", "smiles": "C...", "class": None, "source": "mw"}


def test_mw_hit_full_fields_and_link(tmp_path):
    out = hmdb_api.resolve_hmdb_metadata(
        ["HMDB0000122"], tmp_path / "c.json", retrieved="2026-06-10",
        mw=lambda hid: _mw_meta(), pubchem=lambda n: None)
    m = out["HMDB0000122"]
    assert m["formula"] == "C6H12O6" and m["inchikey"].startswith("WQZGKKKJIJFFOK")
    assert m["link"] == "https://hmdb.ca/metabolites/HMDB0000122"
    assert m["source"] == "mw" and m["retrieved"] == "2026-06-10"


def test_pubchem_fallback_on_mw_miss(tmp_path):
    pc = {"name": "(+)-Fucose", "formula": "C6H12O5", "monoisotopic_mass": "164.06847",
          "inchikey": "PNNNRSAQSRJVSB-DPYQTVNSSA-N", "pubchem_cid": "94270",
          "chebi_id": None, "kegg_id": None, "smiles": None, "class": None, "source": "pubchem"}
    out = hmdb_api.resolve_hmdb_metadata(
        ["HMDB0000174"], tmp_path / "c.json", name_hints={"HMDB0000174": "D-Fucose"},
        mw=lambda hid: None, pubchem=lambda n: pc)
    assert out["HMDB0000174"]["source"] == "pubchem"
    assert out["HMDB0000174"]["formula"] == "C6H12O5"


def test_both_miss_cached_as_null_and_excluded(tmp_path):
    cache = tmp_path / "c.json"
    out = hmdb_api.resolve_hmdb_metadata(["HMDBxxxx"], cache, mw=lambda h: None, pubchem=lambda n: None)
    assert out == {}                                   # null excluded from result
    assert json.loads(cache.read_text()) == {"HMDBxxxx": None}


def test_cache_reuse_skips_fetch(tmp_path):
    cache = tmp_path / "c.json"
    cache.write_text(json.dumps({"HMDB0000122": {**_mw_meta(), "link": "x", "retrieved": "t"}}))
    calls = []
    out = hmdb_api.resolve_hmdb_metadata(
        ["HMDB0000122"], cache, mw=lambda h: calls.append(h) or _mw_meta(), pubchem=lambda n: None)
    assert "HMDB0000122" in out and calls == []        # served from cache, no fetch
