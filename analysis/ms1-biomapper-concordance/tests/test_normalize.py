"""Unit 1 tests: ID normalization, hint building, loading, gate counts."""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import io_and_normalize as io  # noqa: E402


# --- normalize_id symmetry (reference-format vs Biomapper-format) ---

def test_hmdb_padding_symmetry():
    assert io.normalize_id("HMDB", "HMDB00177") == io.normalize_id("HMDB", "HMDB0000177")
    assert io.normalize_id("HMDB", "HMDB00177") == "HMDB0000177"
    assert io.normalize_id("HMDB", "HMDB0031059") == "HMDB0031059"
    assert io.normalize_id("HMDB", "HMDB:HMDB0000177") == "HMDB0000177"


def test_chebi_prefix_and_bare_equal():
    assert io.normalize_id("CHEBI", "CHEBI:15971") == io.normalize_id("CHEBI", "15971")
    assert io.normalize_id("CHEBI", "15971") == "15971"
    assert io.normalize_id("CHEBI", "174627") == "174627"


def test_kegg_uppercase():
    assert io.normalize_id("KEGG.COMPOUND", "c00152") == "C00152"
    assert io.normalize_id("KEGG.COMPOUND", "KEGG:C00152") == "C00152"


def test_pubchem_int_coercion():
    assert io.normalize_id("PUBCHEM.COMPOUND", "5463.0") == "5463"
    assert io.normalize_id("PUBCHEM.COMPOUND", "5463") == "5463"
    assert io.normalize_id("PUBCHEM.COMPOUND", "CID:5463") == "5463"


def test_lipidmaps_keeps_lm_prefix():
    # The leading "LM" is part of the ID, not a CURIE prefix to strip.
    assert io.normalize_id("LIPIDMAPS", "lmfa01010001") == "LMFA01010001"
    assert io.normalize_id("LIPIDMAPS", "LIPIDMAPS:LMFA01010001") == "LMFA01010001"


def test_lipidmaps_lm_prefix_reconciliation():
    # Biomapper kg['LM'] omits the leading "LM"; the reference keeps it. They must compare equal.
    assert io.normalize_id("LIPIDMAPS", "FA01030036") == "LMFA01030036"
    assert io.normalize_id("LIPIDMAPS", "LMFA01030036") == "LMFA01030036"
    assert io.normalize_id("LIPIDMAPS", "FA01030036") == io.normalize_id("LIPIDMAPS", "LMFA01030036")


def test_refmet_id_normalization():
    assert io.normalize_id("RM", "0153615") == "RM0153615"
    assert io.normalize_id("RM", "RM0153615") == "RM0153615"


def test_normalize_name():
    assert io.normalize_name("L-Histidine") == "lhistidine"
    assert io.normalize_name("L Histidine") == io.normalize_name("L-Histidine")
    assert io.normalize_name("NA") is None


def test_biomapper_ids_union_across_dicts():
    result = {
        "identifiers": {"CHEBI": ["15971"], "refmet_id": ["RM0129894"]},
        "kg_equivalent_ids": {"HMDB": ["HMDB0000177"], "LM": ["FA01030036"],
                              "KEGG.COMPOUND": ["C00135"], "PUBCHEM.COMPOUND": ["773", "6274"]},
    }
    assert io.biomapper_ids(result, "CHEBI") == {"15971"}
    assert io.biomapper_ids(result, "HMDB") == {"HMDB0000177"}
    assert io.biomapper_ids(result, "KEGG.COMPOUND") == {"C00135"}
    assert io.biomapper_ids(result, "PUBCHEM.COMPOUND") == {"773", "6274"}
    assert io.biomapper_ids(result, "LIPIDMAPS") == {"LMFA01030036"}  # LM reconciled


def test_biomapper_refmet_ids():
    result = {
        "identifiers": {"refmet_id": ["RM0153615"]},
        "kg_equivalent_ids": {"RM": ["0152805", "0153615"]},
    }
    assert io.biomapper_refmet_ids(result) == {"RM0153615", "RM0152805"}


def test_missing_values_normalize_to_none():
    for v in ["NA", "", "  ", "n/a", "NaN", "None", None]:
        assert io.normalize_id("CHEBI", v) is None


def test_normalize_ids_set_drops_none():
    assert io.normalize_ids("CHEBI", ["15971", "NA", "CHEBI:15971", None]) == {"15971"}
    assert io.normalize_ids("CHEBI", None) == set()
    assert io.normalize_ids("CHEBI", []) == set()


# --- build_hints ---

def test_build_hints_only_populated_namespaces():
    row = pd.Series(
        {"hmdb_id": "HMDB00177", "chebi_id": "15971", "kegg_id": "NA",
         "lipidmaps_id": "", "pubchem_cid": "5463.0"}
    )
    assert io.build_hints(row) == {
        "HMDB": "HMDB0000177",
        "CHEBI": "15971",
        "PUBCHEM.COMPOUND": "5463",
    }


def test_build_hints_unannotated_row_returns_empty_dict():
    row = pd.Series({c: "NA" for c in io.COLUMN_TO_IDENTIFIERS_PREFIX})
    result = io.build_hints(row)
    assert result == {}
    assert result is not None


# --- loading + distinct_names + gate ---

@pytest.fixture
def sample_csv(tmp_path) -> Path:
    p = tmp_path / "sample.csv"
    pd.DataFrame(
        {
            "feature_id": ["1", "2", "2", "3"],   # feature_id 2 repeats with distinct names
            "matched_name": ["Glucose", "Taurine", "Taurine alt", "Lipid X"],
            "match_level": ["CURATION", "MS2", "MS2", "MS1"],
            "chebi_id": ["17234", "NA", "NA", "NA"],
            "hmdb_id": ["HMDB0000122", "NA", "NA", "NA"],
            "kegg_id": ["NA", "NA", "NA", "NA"],
            "lipidmaps_id": ["NA", "NA", "NA", "NA"],
            "pubchem_cid": ["NA", "NA", "NA", "NA"],
            "super_class": ["Carbohydrates", "NA", "NA", "Lipids"],
            "main_class": ["NA", "NA", "NA", "Glycerolipids"],
            "sub_class": ["NA", "NA", "NA", "NA"],
        }
    ).to_csv(p, index=False)
    return p


def test_load_features_reads_and_warns_on_dupes(sample_csv, capsys):
    df = io.load_features(sample_csv)
    assert len(df) == 4
    out = capsys.readouterr().out
    assert "feature_id(s) repeat" in out
    # distinct names because the two feature_id=2 rows carry different matched_names
    assert "join key is NOT unique" not in out


def test_distinct_names_dedupes(sample_csv):
    df = io.load_features(sample_csv)
    names = io.distinct_names(df)
    assert names == ["Glucose", "Taurine", "Taurine alt", "Lipid X"]


def test_count_class_without_id(sample_csv):
    df = io.load_features(sample_csv)
    # "Lipid X" (feature 3) has a class but no ID; Glucose has both; Taurine rows have neither.
    assert io.count_class_without_id(df) == 1
