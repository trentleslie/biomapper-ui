"""SDK/env capture + ordering-trust policy for benchmark runs (plan Unit 1).

The BioMapper SDK exposes only a single scalar confidence per result — no per-candidate
confidence — so a runtime "ordering probe" is impossible. Instead we *trust* the
``identifiers`` list order as descending confidence by contract (design doc L34), gated on
the captured SDK version, and record that trust as ``order_asserted`` on every run so the
scorer/UI can *label* (not suppress) rank metrics.
"""
from __future__ import annotations

from importlib import metadata

# SDK versions known to return confidence-ordered ``ids_for()`` lists. Extend as the
# contract is re-confirmed against new releases; a version outside this policy still runs
# but rank metrics are flagged (order_asserted=False).
_ORDER_ASSERTED_MIN = (1, 0, 0)


def _parse_version(v: str) -> tuple[int, ...] | None:
    parts: list[int] = []
    for chunk in v.split(".")[:3]:
        num = "".join(ch for ch in chunk if ch.isdigit())
        if not num:
            break
        parts.append(int(num))
    return tuple(parts) if parts else None


def get_sdk_version() -> str:
    try:
        return metadata.version("biomapper")
    except Exception:
        return "unknown"


def order_is_asserted(version: str) -> bool:
    parsed = _parse_version(version)
    if parsed is None:
        return False
    return parsed >= _ORDER_ASSERTED_MIN


def capture(env: str, base_url: str | None = None) -> dict:
    """Return the reproducibility/ordering metadata for a benchmark run."""
    version = get_sdk_version()
    return {
        "sdkVersion": version,
        "env": env or "unknown",
        "baseUrl": base_url,
        "orderAsserted": order_is_asserted(version),
    }
