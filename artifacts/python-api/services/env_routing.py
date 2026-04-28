import os

from fastapi import HTTPException

_VALID_ENVS = {"production", "dev"}


def resolve_env_base_url(env_header: str | None) -> tuple[str, str]:
    """Resolve the biomapper2 base URL from the environment header.

    Returns (env, base_url) where env is the validated environment name
    and base_url is the corresponding URL.

    Raises HTTPException 400 for invalid header values, 503 if
    BIOMAPPER_DEV_BASE_URL is not configured when dev is requested.
    """
    env = (env_header or "production").strip().lower()

    if env not in _VALID_ENVS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid X-Biomapper-Env value '{env_header}'. Valid values: production, dev",
        )

    if env == "dev":
        dev_url = os.environ.get("BIOMAPPER_DEV_BASE_URL", "").strip()
        if not dev_url:
            raise HTTPException(
                status_code=503,
                detail="Dev API environment is not configured (BIOMAPPER_DEV_BASE_URL not set)",
            )
        return env, dev_url

    # production
    prod_url = os.environ.get("BIOMAPPER_BASE_URL", "").strip() or None
    return env, prod_url  # type: ignore[return-value]
