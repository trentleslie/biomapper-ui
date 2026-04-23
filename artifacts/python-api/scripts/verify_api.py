#!/usr/bin/env python3
"""Verify that the BioMapper2 API returns real, correct results for known compounds.

Usage:
    python verify_api.py

Set BIOMAPPER_BASE_URL to override the default API endpoint (e.g. http://localhost:8000).
Requires BIOMAPPER_API_KEY to be set (or passed via the SDK's default env-var lookup).

Exit code 0 = all compounds passed; non-zero = at least one failure.
"""

from __future__ import annotations

import asyncio
import os
import re
import sys
from dataclasses import dataclass

from biomapper import BioMapperClient, BioMapperConfigError


# ---------------------------------------------------------------------------
# Fixtures: known compounds with at least one expected HMDB and CHEBI id each
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ExpectedCompound:
    name: str
    hmdb: str   # e.g. "HMDB0000177"
    chebi: str  # e.g. "CHEBI:15971"


FIXTURES: list[ExpectedCompound] = [
    ExpectedCompound("L-Histidine",  "HMDB0000177", "CHEBI:15971"),
    ExpectedCompound("D-Glucose",     "HMDB0000122", "CHEBI:17634"),
    ExpectedCompound("Acetyl-CoA",   "HMDB0001206", "CHEBI:15351"),
    ExpectedCompound("Creatinine",   "HMDB0000562", "CHEBI:16737"),
    ExpectedCompound("Tryptophan",   "HMDB0000929", "CHEBI:16828"),
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_NUMERIC_RE = re.compile(r"\d+")


def extract_numeric(identifier: str) -> str | None:
    """Strip all prefixes and return the numeric portion for comparison.

    Examples:
        "HMDB0000177"  -> "0000177"
        "HMDB:HMDB0000177" -> "0000177"  (last numeric run)
        "CHEBI:15971"  -> "15971"
    """
    matches = _NUMERIC_RE.findall(identifier)
    return matches[-1] if matches else None


def id_matches(expected: str, returned_ids: list[str]) -> bool:
    """Return True if the expected identifier's numeric portion appears in any
    of the returned identifiers (also compared by numeric portion)."""
    expected_num = extract_numeric(expected)
    if expected_num is None:
        return False
    for rid in returned_ids:
        if extract_numeric(rid) == expected_num:
            return True
    return False


# ---------------------------------------------------------------------------
# Main verification
# ---------------------------------------------------------------------------

async def verify() -> bool:
    """Run verification for all fixture compounds. Returns True if all pass."""

    client_kwargs: dict[str, object] = {}
    base_url = os.environ.get("BIOMAPPER_BASE_URL", "").strip()
    if base_url:
        client_kwargs["base_url"] = base_url

    try:
        client_ctx = BioMapperClient(**client_kwargs)  # SDK default 30s timeout
    except BioMapperConfigError as exc:
        print(f"FATAL: {exc}", file=sys.stderr)
        return False

    all_passed = True

    async with client_ctx as client:
        for fixture in FIXTURES:
            print(f"\n{'=' * 60}")
            print(f"Compound: {fixture.name}")
            print(f"  Expected HMDB:  {fixture.hmdb}")
            print(f"  Expected CHEBI: {fixture.chebi}")
            print("-" * 60)

            try:
                result = await client.map_entity(name=fixture.name)
            except Exception as exc:
                print(f"  ERROR: {exc}")
                print(f"  RESULT: FAIL")
                all_passed = False
                continue

            # Extract identifiers
            hmdb_ids: list[str] = result.ids_for("HMDB")
            chebi_ids: list[str] = result.ids_for("CHEBI")

            # Print full results
            print(f"  Resolved:         {result.resolved}")
            print(f"  Primary CURIE:    {result.primary_curie}")
            print(f"  Confidence tier:  {result.confidence_tier}")
            print(f"  Confidence score: {result.confidence_score}")
            print(f"  HMDB IDs:         {hmdb_ids}")
            print(f"  CHEBI IDs:        {chebi_ids}")

            # Also show other identifiers for completeness
            for vocab in ("PUBCHEM.COMPOUND", "refmet_id", "LIPIDMAPS",
                          "KEGG.COMPOUND", "UMLS", "MESH", "UNII", "ChEMBL"):
                ids = result.ids_for(vocab)
                if ids:
                    print(f"  {vocab}: {ids}")

            # Pass/fail: at least one expected identifier must match
            hmdb_ok = id_matches(fixture.hmdb, hmdb_ids)
            chebi_ok = id_matches(fixture.chebi, chebi_ids)
            passed = hmdb_ok or chebi_ok

            if not passed:
                all_passed = False
            status = "PASS" if passed else "FAIL"
            detail_parts: list[str] = []
            detail_parts.append(f"HMDB {'match' if hmdb_ok else 'MISS'}")
            detail_parts.append(f"CHEBI {'match' if chebi_ok else 'MISS'}")
            print(f"  RESULT: {status} ({', '.join(detail_parts)})")

    return all_passed


def main() -> None:
    success = asyncio.run(verify())

    if success:
        print(f"\n{'=' * 60}")
        print("ALL COMPOUNDS PASSED")
        print("=" * 60)
        print(
            "\nREMINDER: Pin the biomapper package version in your requirements "
            "to lock in these verified results.\n"
            "  e.g.  biomapper==X.Y.Z\n"
        )
    else:
        print(f"\n{'=' * 60}")
        print("SOME COMPOUNDS FAILED -- see details above")
        print("=" * 60)
        sys.exit(1)


if __name__ == "__main__":
    main()
