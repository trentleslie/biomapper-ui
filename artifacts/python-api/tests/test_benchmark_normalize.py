import pytest

from services.benchmark_normalize import (
    SOURCE_IDENTIFIERS,
    SOURCE_KG,
    assemble_candidates,
    normalize_gt_set,
    normalize_id,
)


class TestNormalizeId:
    def test_hmdb_zero_pad(self):
        assert normalize_id("hmdb", "HMDB294") == "HMDB0000294"
        assert normalize_id("hmdb", "HMDB0000294") == "HMDB0000294"
        assert normalize_id("hmdb", "hmdb122") == "HMDB0000122"

    def test_chebi_prefix(self):
        assert normalize_id("chebi", "17234") == "CHEBI:17234"
        assert normalize_id("chebi", "CHEBI:17234") == "CHEBI:17234"
        assert normalize_id("chebi", "chebi:17234") == "CHEBI:17234"

    def test_lipidmaps_upper(self):
        assert normalize_id("lipidmaps", "lmfa01010001") == "LMFA01010001"

    def test_pubchem_bare(self):
        assert normalize_id("pubchem", "CID:5793") == "5793"
        assert normalize_id("pubchem", "5793") == "5793"

    def test_refmet_name_canonical(self):
        assert normalize_id("refmet", "  Glucose ") == "glucose"

    def test_kegg_upper(self):
        assert normalize_id("kegg", "c00031") == "C00031"

    def test_malformed_raises(self):
        for bad in ["HMDB", "", "   ", ";;", "abc"]:
            with pytest.raises(ValueError):
                normalize_id("hmdb", bad)

    def test_unknown_vocab_fallback(self):
        assert normalize_id("weirdvocab", " Foo Bar ") == "foo bar"


class TestNormalizeGtSet:
    def test_multi_item(self):
        s, malformed = normalize_gt_set("hmdb", ["HMDB294", "HMDB0000122"])
        assert s == {"HMDB0000294", "HMDB0000122"}
        assert malformed is False

    def test_all_malformed(self):
        s, malformed = normalize_gt_set("hmdb", ["HMDB", "nope"])
        assert s == set()
        assert malformed is True

    def test_partial_malformed_not_flagged(self):
        s, malformed = normalize_gt_set("hmdb", ["HMDB294", "nope"])
        assert s == {"HMDB0000294"}
        assert malformed is False

    def test_empty(self):
        s, malformed = normalize_gt_set("hmdb", ["", "  "])
        assert s == set()
        assert malformed is False


class TestAssembleCandidates:
    def test_identifiers_order_preserved(self):
        result = {"identifiers": {"hmdb": ["HMDB0000001", "HMDB0000002"]}, "kgEquivalentIds": {}}
        cands, malformed = assemble_candidates(result, "hmdb")
        assert [c.normalized for c in cands] == ["HMDB0000001", "HMDB0000002"]
        assert all(c.source == SOURCE_IDENTIFIERS for c in cands)
        assert malformed is False

    def test_hmdb_only_in_kg_equivalents(self):
        result = {"identifiers": {"hmdb": []}, "kgEquivalentIds": {"HMDB": ["HMDB294"]}}
        cands, _ = assemble_candidates(result, "hmdb")
        assert [c.normalized for c in cands] == ["HMDB0000294"]
        assert cands[0].source == SOURCE_KG

    def test_kg_appended_after_identifiers(self):
        result = {
            "identifiers": {"hmdb": ["HMDB0000002"]},
            "kgEquivalentIds": {"HMDB": ["HMDB0000001"]},
        }
        cands, _ = assemble_candidates(result, "hmdb")
        # identifiers item holds rank 0 even though kg id sorts lower
        assert [c.normalized for c in cands] == ["HMDB0000002", "HMDB0000001"]
        assert cands[0].source == SOURCE_IDENTIFIERS
        assert cands[1].source == SOURCE_KG

    def test_dedup_across_sources_keeps_first(self):
        result = {
            "identifiers": {"hmdb": ["HMDB294"]},
            "kgEquivalentIds": {"HMDB": ["HMDB0000294"]},
        }
        cands, _ = assemble_candidates(result, "hmdb")
        assert [c.normalized for c in cands] == ["HMDB0000294"]
        assert cands[0].source == SOURCE_IDENTIFIERS  # identifiers occurrence kept

    def test_lipidmaps_kg_key(self):
        result = {"identifiers": {}, "kgEquivalentIds": {"LM": ["lmfa01010001"]}}
        cands, _ = assemble_candidates(result, "lipidmaps")
        assert [c.normalized for c in cands] == ["LMFA01010001"]

    def test_all_malformed_returned(self):
        result = {"identifiers": {"hmdb": ["HMDB", "junk"]}, "kgEquivalentIds": {}}
        cands, malformed = assemble_candidates(result, "hmdb")
        assert cands == []
        assert malformed is True
