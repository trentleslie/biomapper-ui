import asyncio
from unittest.mock import MagicMock, AsyncMock, patch

from services.mapper import MapperService
from models.schemas import MappingConfig


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
        from unittest.mock import PropertyMock

        result = _make_mock_result()
        # MagicMock never raises AttributeError on its own, so we must force it.
        type(result).kg_equivalent_ids = PropertyMock(side_effect=AttributeError)

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


class TestProvidedIds:
    """Tests for providedIds injection in _map_with_retry."""

    def _run(self, coro):
        return asyncio.run(coro)

    def test_hint_columns_maps_prefix_to_original_column(self):
        """hint_columns={'HMDB': 'provided_ids'} causes providedIds to use 'provided_ids' as key."""
        mock_result = _make_mock_result()
        config = MappingConfig(
            hints={"creatine": {"HMDB": "HMDB0000294"}},
            hint_columns={"HMDB": "provided_ids"},
        )
        service = MapperService(base_url_override="http://fake")
        stop_event = asyncio.Event()

        with patch("services.mapper.BioMapperClient") as MockClient:
            mock_client = AsyncMock()
            mock_client.map_entity = AsyncMock(return_value=mock_result)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            MockClient.return_value = mock_client

            result = self._run(service._map_with_retry("creatine", config, stop_event))

        assert "providedIds" in result
        assert result["providedIds"] == {"provided_ids": "HMDB0000294"}

    def test_no_hints_returns_empty_provided_ids(self):
        """Entity with no hints produces providedIds: {}."""
        mock_result = _make_mock_result()
        config = MappingConfig(hints={}, hint_columns={})
        service = MapperService(base_url_override="http://fake")
        stop_event = asyncio.Event()

        with patch("services.mapper.BioMapperClient") as MockClient:
            mock_client = AsyncMock()
            mock_client.map_entity = AsyncMock(return_value=mock_result)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            MockClient.return_value = mock_client

            result = self._run(service._map_with_retry("unknown", config, stop_event))

        assert "providedIds" in result
        assert result["providedIds"] == {}

    def test_multiple_hint_columns(self):
        """Multiple hint columns each appear keyed by their original column name."""
        mock_result = _make_mock_result()
        config = MappingConfig(
            hints={"taurine": {"HMDB": "HMDB0000251", "CHEBI": "15891"}},
            hint_columns={"HMDB": "hmdb_col", "CHEBI": "chebi_col"},
        )
        service = MapperService(base_url_override="http://fake")
        stop_event = asyncio.Event()

        with patch("services.mapper.BioMapperClient") as MockClient:
            mock_client = AsyncMock()
            mock_client.map_entity = AsyncMock(return_value=mock_result)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            MockClient.return_value = mock_client

            result = self._run(service._map_with_retry("taurine", config, stop_event))

        assert result["providedIds"] == {"hmdb_col": "HMDB0000251", "chebi_col": "15891"}

    def test_hint_columns_missing_prefix_falls_back_to_prefix_key(self):
        """When hint_columns doesn't map a prefix, the prefix itself is the key."""
        mock_result = _make_mock_result()
        config = MappingConfig(
            hints={"alanine": {"HMDB": "HMDB0000161"}},
            hint_columns={},  # no mapping
        )
        service = MapperService(base_url_override="http://fake")
        stop_event = asyncio.Event()

        with patch("services.mapper.BioMapperClient") as MockClient:
            mock_client = AsyncMock()
            mock_client.map_entity = AsyncMock(return_value=mock_result)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            MockClient.return_value = mock_client

            result = self._run(service._map_with_retry("alanine", config, stop_event))

        assert result["providedIds"] == {"HMDB": "HMDB0000161"}
