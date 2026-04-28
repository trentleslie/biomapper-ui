import asyncio
import logging
import os
from typing import Any, AsyncIterator

from biomapper import (
    BioMapperClient,
    BioMapperAuthError,
    BioMapperConfigError,
    BioMapperRateLimitError,
    BioMapperError,
)

from models.schemas import MappingConfig

logger = logging.getLogger("entity-linker.mapper")

MAX_CONCURRENCY = 10
MAX_RETRIES = 3


class MapperService:
    def __init__(self, base_url_override: str | None = None) -> None:
        self.base_url = base_url_override if base_url_override is not None else self._get_base_url()

    @staticmethod
    def _get_base_url() -> str | None:
        value = os.environ.get("BIOMAPPER_BASE_URL")
        if value:
            value = value.strip()
        return value or None

    def _client_kwargs(self) -> dict[str, Any]:
        kwargs: dict[str, Any] = {}
        if self.base_url:
            kwargs["base_url"] = self.base_url
        return kwargs

    async def map_batch(
        self,
        names: list[str],
        config: MappingConfig,
    ) -> AsyncIterator[dict[str, Any]]:
        """Process names with bounded concurrency, yielding results as they complete."""
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        semaphore = asyncio.Semaphore(MAX_CONCURRENCY)
        stop_event = asyncio.Event()

        async def process_one(name: str) -> None:
            async with semaphore:
                if stop_event.is_set():
                    await queue.put({"name": name, "skipped": True, "resolved": False})
                    return
                try:
                    result = await self._map_with_retry(name, config, stop_event)
                except Exception as e:
                    result = {
                        "name": name,
                        "resolved": False,
                        "error": str(e),
                        "error_type": "mapping_error",
                    }
                await queue.put(result)

        tasks = [asyncio.create_task(process_one(name)) for name in names]

        for _ in range(len(names)):
            result = await queue.get()
            yield result

        await asyncio.gather(*tasks, return_exceptions=True)

    async def _map_with_retry(
        self,
        name: str,
        config: MappingConfig,
        stop_event: asyncio.Event,
        max_retries: int = MAX_RETRIES,
    ) -> dict[str, Any]:
        hints = config.hints.get(name, {})
        identifiers: dict[str, str] | None = None
        if hints:
            identifiers = {k: (v[0] if isinstance(v, list) else v) for k, v in hints.items()}

        # Treat both None and [] as "use all annotators" — forward None to
        # the client. Passing an empty list could be interpreted as "use zero
        # annotators" and silently produce empty results.
        annotators_arg: list[str] | None = config.annotators or None

        last_error: str = "Unknown error"

        try:
            client_ctx = BioMapperClient(**self._client_kwargs())
        except BioMapperConfigError as e:
            stop_event.set()
            return {
                "name": name,
                "resolved": False,
                "error": f"API key not configured — {e}",
                "error_type": "config_error",
            }

        async with client_ctx as client:
            for attempt in range(max_retries):
                if stop_event.is_set():
                    return {
                        "name": name,
                        "resolved": False,
                        "error": "Job aborted due to prior auth failure.",
                        "error_type": "aborted",
                    }
                try:
                    logger.debug(
                        "map_entity name=%r entity_type=%r annotation_mode=%r annotators=%r identifiers=%r",
                        name,
                        config.entity_type,
                        config.annotation_mode,
                        annotators_arg,
                        identifiers,
                    )
                    result = await client.map_entity(
                        name=name,
                        entity_type=config.entity_type,
                        identifiers=identifiers,
                        annotation_mode=config.annotation_mode,
                        annotators=annotators_arg,
                    )
                    return self._process_result(name, result)

                except BioMapperAuthError:
                    stop_event.set()
                    return {
                        "name": name,
                        "resolved": False,
                        "error": "API authentication failed — check BIOMAPPER_API_KEY configuration.",
                        "error_type": "auth_failure",
                    }

                except BioMapperRateLimitError:
                    last_error = "Rate limited"
                    await asyncio.sleep(2**attempt)

                except BioMapperError as e:
                    last_error = str(e)
                    if attempt < max_retries - 1:
                        await asyncio.sleep(2**attempt)

                except Exception as e:
                    last_error = str(e)
                    if attempt < max_retries - 1:
                        await asyncio.sleep(2**attempt)

        return {
            "name": name,
            "resolved": False,
            "error": last_error,
            "error_type": "mapping_error",
        }

    @staticmethod
    def _process_result(name: str, result: Any) -> dict[str, Any]:
        processed: dict[str, Any] = {
            "name": name,
            "resolved": result.resolved,
            "primaryCurie": result.primary_curie,
            "confidenceScore": result.confidence_score,
            "confidenceTier": result.confidence_tier,
            "needsReview": result.confidence_tier in ("low", "unknown"),
            "identifiers": {
                "hmdb": result.ids_for("HMDB"),
                "chebi": result.ids_for("CHEBI"),
                "pubchem": result.ids_for("PUBCHEM.COMPOUND"),
                "refmet": result.ids_for("refmet_id"),
                "lipidmaps": result.ids_for("LIPIDMAPS"),
                "kegg": result.ids_for("KEGG.COMPOUND"),
                "umls": result.ids_for("UMLS"),
                "mesh": result.ids_for("MESH"),
                "unii": result.ids_for("UNII"),
                "chembl": result.ids_for("ChEMBL"),
            },
        }
        kg_equiv = getattr(result, "kg_equivalent_ids", None)
        if kg_equiv:
            processed["kg_equivalent_ids"] = list(kg_equiv)
        return processed
