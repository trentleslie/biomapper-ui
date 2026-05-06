from unittest.mock import MagicMock

from services.mapper import MapperService


def _make_mock_result(**overrides):
    """Create a mock biomapper MappingResult with sensible defaults."""
    result = MagicMock()
    result.resolved = overrides.get("resolved", True)
    result.primary_curie = overrides.get("primary_curie", "CHEBI:16113")
    result.confidence_score = overrides.get("confidence_score", 0.95)
    result.confidence_tier = overrides.get("confidence_tier", "high")
    result.ids_for = MagicMock(return_value=[])
    result.kg_equivalent_ids = overrides.get("kg_equivalent_ids", {})
    return result


class TestProcessResult:
    """Tests for MapperService._process_result."""

    def test_happy_path_kg_equivalent_ids(self):
        """Full dict with multiple prefixes is passed through under camelCase key."""
        equiv = {"HMDB": ["HMDB0000067"], "CHEBI": ["16113", "172955"]}
        result = _make_mock_result(kg_equivalent_ids=equiv)

        processed = MapperService._process_result("cholesterol", result)

        assert "kgEquivalentIds" in processed
        assert processed["kgEquivalentIds"] == {"HMDB": ["HMDB0000067"], "CHEBI": ["16113", "172955"]}

    def test_empty_dict_returns_empty_dict(self):
        """Empty dict from SDK is preserved, not omitted."""
        result = _make_mock_result(kg_equivalent_ids={})

        processed = MapperService._process_result("unknown-entity", result)

        assert "kgEquivalentIds" in processed
        assert processed["kgEquivalentIds"] == {}

    def test_none_returns_empty_dict(self):
        """None attribute defaults to empty dict."""
        result = _make_mock_result(kg_equivalent_ids=None)

        processed = MapperService._process_result("unknown-entity", result)

        assert "kgEquivalentIds" in processed
        assert processed["kgEquivalentIds"] == {}

    def test_absent_attribute_returns_empty_dict(self):
        """Missing attribute (older SDK) defaults to empty dict via getattr."""
        result = _make_mock_result()
        del result.kg_equivalent_ids  # simulate absent attribute

        processed = MapperService._process_result("unknown-entity", result)

        assert "kgEquivalentIds" in processed
        assert processed["kgEquivalentIds"] == {}

    def test_values_are_id_lists_not_prefix_keys(self):
        """Regression: output values are lists of IDs, not a flat list of prefix strings."""
        equiv = {"HMDB": ["HMDB0000067"], "CHEBI": ["16113"]}
        result = _make_mock_result(kg_equivalent_ids=equiv)

        processed = MapperService._process_result("cholesterol", result)

        # Must be a dict, not a list
        assert isinstance(processed["kgEquivalentIds"], dict)
        # Values must be lists of ID strings
        for prefix, ids in processed["kgEquivalentIds"].items():
            assert isinstance(ids, list)
            for id_str in ids:
                assert isinstance(id_str, str)

    def test_key_is_camel_case(self):
        """Field name must be camelCase kgEquivalentIds, not snake_case."""
        result = _make_mock_result(kg_equivalent_ids={"HMDB": ["HMDB0000067"]})

        processed = MapperService._process_result("cholesterol", result)

        assert "kgEquivalentIds" in processed
        assert "kg_equivalent_ids" not in processed

    def test_existing_fields_unchanged(self):
        """Existing result fields are preserved."""
        result = _make_mock_result(
            resolved=True,
            primary_curie="CHEBI:16113",
            confidence_score=0.95,
            confidence_tier="high",
        )

        processed = MapperService._process_result("cholesterol", result)

        assert processed["resolved"] is True
        assert processed["primaryCurie"] == "CHEBI:16113"
        assert processed["confidenceScore"] == 0.95
        assert processed["confidenceTier"] == "high"
        assert processed["needsReview"] is False
        assert "identifiers" in processed
