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
    result.max_annotator_score = overrides.get("max_annotator_score", None)
    result.ids_for = MagicMock(return_value=[])
    result.kg_equivalent_ids = overrides.get("kg_equivalent_ids", {})
    result.chosen_kg_id_review = overrides.get("chosen_kg_id_review", None)
    result.chosen_kg_id = overrides.get("chosen_kg_id", None)
    result.certificate = overrides.get("certificate", None)
    result.lipid_resolution = overrides.get("lipid_resolution", None)
    result.name_is_mixture = overrides.get("name_is_mixture", None)
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

    def test_chosen_kg_id_review_surfaced_and_flags_needs_review(self):
        """A resolver review flag is surfaced and marks the row for review, even at high confidence."""
        result = _make_mock_result(confidence_tier="high", chosen_kg_id_review="divergent_refmet")

        processed = MapperService._process_result("citrate", result)

        assert processed["chosenKgIdReview"] == "divergent_refmet"
        assert processed["needsReview"] is True

    def test_no_review_flag_keeps_needs_review_false(self):
        """High-confidence result with no review flag is not flagged for review."""
        result = _make_mock_result(confidence_tier="high", chosen_kg_id_review=None)

        processed = MapperService._process_result("glucose", result)

        assert processed["chosenKgIdReview"] is None
        assert processed["needsReview"] is False

    def test_resolved_row_without_score_is_not_scored_not_low(self):
        result = _make_mock_result(
            resolved=True, confidence_score=None, confidence_tier="unknown", max_annotator_score=2.4
        )

        row = MapperService._process_result("x", result)

        assert row["confidenceTier"] == "unknown"
        assert row["confidenceScore"] is None
        assert row["maxAnnotatorScore"] == 2.4
        assert row["reviewReason"] == "not_scored"
        assert row["needsReview"] is True

    def test_low_score_still_needs_review(self):
        result = _make_mock_result(resolved=True, confidence_score=0.4, confidence_tier="low")

        row = MapperService._process_result("x", result)

        assert row["confidenceTier"] == "low" and row["needsReview"] is True
        assert row["reviewReason"] == "low_confidence"

    def test_chebi_conflict_review_takes_precedence_over_not_scored(self):
        result = _make_mock_result(
            confidence_score=None, confidence_tier="unknown", chosen_kg_id_review="divergent_refmet"
        )

        row = MapperService._process_result("x", result)

        assert row["reviewReason"] == "divergent_refmet"
        assert row["needsReview"] is True

    def test_high_score_has_no_review_reason(self):
        row = MapperService._process_result("x", _make_mock_result())

        assert row["reviewReason"] is None
        assert row["maxAnnotatorScore"] is None

    def test_unresolved_row_is_not_not_scored(self):
        result = _make_mock_result(resolved=False, confidence_score=None, confidence_tier="unknown")

        row = MapperService._process_result("x", result)

        assert row["reviewReason"] is None


class TestHarmonizeFields:
    """The fields biomapper.harmonize.harmonize() reads, stored so a finished job can be linked."""

    def _result(self, **fields):
        from biomapper import MappingResult

        return MappingResult(query_name="x", **fields)

    def test_chosen_kg_id_is_stored_apart_from_primary_curie(self):
        row = MapperService._process_result("x", self._result(
            resolved=True, primary_curie="RM:0129894", chosen_kg_id="CHEBI:17234"))

        assert row["chosenKgId"] == "CHEBI:17234"
        assert row["primaryCurie"] == "RM:0129894"

    def test_unresolved_row_stores_nulls(self):
        row = MapperService._process_result("x", self._result())

        assert row["chosenKgId"] is None
        assert row["certificateState"] is None
        assert row["nameIsMixture"] is None

    def test_certificate_state_is_stored(self):
        from biomapper.models import ResolutionCertificate

        row = MapperService._process_result("x", self._result(
            resolved=True, chosen_kg_id="CHEBI:1",
            certificate=ResolutionCertificate(state="contradicted")))

        assert row["certificateState"] == "contradicted"

    def test_engine_mixture_flag_is_stored(self):
        row = MapperService._process_result("x", self._result(name_is_mixture=False))
        assert row["nameIsMixture"] is False

    def test_lipid_mixture_flag_counts_even_when_top_level_says_false(self):
        """harmonize() treats name_is_mixture and lipid_resolution.name_is_mixture as an OR."""
        from biomapper.models import LipidResolution

        row = MapperService._process_result("x", self._result(
            name_is_mixture=False, lipid_resolution=LipidResolution(name_is_mixture=True)))

        assert row["nameIsMixture"] is True

    def test_existing_fields_are_computed_as_before(self):
        before = {k: v for k, v in MapperService._process_result("x", _make_mock_result()).items()
                  if k not in ("chosenKgId", "certificateState", "nameIsMixture")}

        assert set(before) == {"name", "resolved", "primaryCurie", "confidenceScore",
                               "confidenceTier", "maxAnnotatorScore", "reviewReason",
                               "chosenKgIdReview", "needsReview", "identifiers",
                               "kgEquivalentIds"}


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
