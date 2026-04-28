import logging
import time
from typing import Any, Awaitable, Callable

from fastapi import APIRouter, Header, HTTPException, Request

from biomapper import (
    BioMapperClient,
    BioMapperConfigError,
    BioMapperError,
)

from services.env_routing import resolve_env_base_url
from services.mapper import MapperService

logger = logging.getLogger("entity-linker.discovery")

router = APIRouter()

POSITIVE_TTL_SECONDS = 60 * 60
NEGATIVE_TTL_SECONDS = 30

_cache: dict[str, dict[str, Any]] = {}


def _get_cached(key: str) -> tuple[bool, Any]:
    entry = _cache.get(key)
    if entry is None:
        return False, None
    if entry["expires_at"] < time.time():
        return False, None
    return True, entry


def _set_cache(key: str, value: Any, ttl: int, error: bool = False) -> None:
    _cache[key] = {
        "value": value,
        "error": error,
        "expires_at": time.time() + ttl,
    }


async def _fetch_with_cache(
    key: str,
    fetcher: Callable[[BioMapperClient], Awaitable[list[Any]]],
    base_url: str | None = None,
) -> list[dict[str, Any]]:
    found, entry = _get_cached(key)
    if found:
        if entry["error"]:
            raise HTTPException(status_code=502, detail=entry["value"])
        return entry["value"]

    resolved_url = base_url if base_url is not None else MapperService._get_base_url()
    client_kwargs: dict[str, Any] = {}
    if resolved_url:
        client_kwargs["base_url"] = resolved_url

    try:
        async with BioMapperClient(**client_kwargs) as client:
            items = await fetcher(client)
        serialized = [item.model_dump() for item in items]
        _set_cache(key, serialized, POSITIVE_TTL_SECONDS)
        return serialized
    except BioMapperConfigError as e:
        msg = f"BioMapper API key not configured — {e}"
        _set_cache(key, msg, NEGATIVE_TTL_SECONDS, error=True)
        raise HTTPException(status_code=502, detail=msg)
    except BioMapperError as e:
        msg = f"BioMapper discovery failed: {e}"
        _set_cache(key, msg, NEGATIVE_TTL_SECONDS, error=True)
        raise HTTPException(status_code=502, detail=msg)
    except Exception as e:
        msg = f"BioMapper discovery error: {e}"
        _set_cache(key, msg, NEGATIVE_TTL_SECONDS, error=True)
        logger.exception("Discovery fetch failed for %s", key)
        raise HTTPException(status_code=502, detail=msg)


@router.get("/entity-types")
async def get_entity_types(x_biomapper_env: str | None = Header(None)) -> list[dict[str, Any]]:
    env, base_url = resolve_env_base_url(x_biomapper_env)
    return await _fetch_with_cache(
        f"{env}:entity-types",
        lambda client: client.list_entity_types(),
        base_url=base_url,
    )


@router.get("/annotators")
async def get_annotators(x_biomapper_env: str | None = Header(None)) -> list[dict[str, Any]]:
    env, base_url = resolve_env_base_url(x_biomapper_env)
    return await _fetch_with_cache(
        f"{env}:annotators",
        lambda client: client.list_annotators(),
        base_url=base_url,
    )


@router.get("/vocabularies")
async def get_vocabularies(x_biomapper_env: str | None = Header(None)) -> list[dict[str, Any]]:
    env, base_url = resolve_env_base_url(x_biomapper_env)
    return await _fetch_with_cache(
        f"{env}:vocabularies",
        lambda client: client.list_vocabularies(),
        base_url=base_url,
    )
