"""Per-vocabulary ID normalization + merged candidate assembly for benchmarking.

Implements the ``normalize_id`` contract from ``biomapper-eval-metrics-design.md``.
Built fresh (the offline ``analysis/ms1-biomapper-concordance`` code returns unordered
sets, which would destroy the ranks ``hit_ranks`` depends on — see plan RC-2). The merge
here is an *order-preserving* de-dup so downstream rank metrics are meaningful.

A ``ValueError`` from :func:`normalize_id` means the raw value is malformed for that
vocabulary; callers translate that into the ``MALFORMED_*`` scorer categories.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# Candidate sourced from the confidence-ordered ``identifiers`` map vs. the unscored
# ``kgEquivalentIds`` map. Ordering is only trustworthy for ``identifiers`` items, so
# kg-only items are always appended after identifiers items (see plan RC-1).
SOURCE_IDENTIFIERS = "identifiers"
SOURCE_KG = "kg"


@dataclass(frozen=True)
class Candidate:
    """A normalized returned identifier with provenance and its raw form."""

    normalized: str
    raw: str
    source: str  # SOURCE_IDENTIFIERS | SOURCE_KG


# Maps a benchmark vocabulary key to the ``identifiers`` dict key and the
# ``kgEquivalentIds`` prefixes that carry the same vocabulary.
NAMESPACE_SOURCE_KEYS: dict[str, dict[str, object]] = {
    "hmdb": {"identifiers": "hmdb", "kg": ["HMDB"]},
    "chebi": {"identifiers": "chebi", "kg": ["CHEBI"]},
    "pubchem": {"identifiers": "pubchem", "kg": ["PUBCHEM.COMPOUND", "PUBCHEM"]},
    "refmet": {"identifiers": "refmet", "kg": ["REFMET"]},
    "lipidmaps": {"identifiers": "lipidmaps", "kg": ["LM", "LIPIDMAPS"]},
    "kegg": {"identifiers": "kegg", "kg": ["KEGG.COMPOUND", "KEGG"]},
}

_HMDB_RE = re.compile(r"^HMDB0*([0-9]+)$", re.IGNORECASE)
_CHEBI_RE = re.compile(r"^(?:CHEBI[:_])?([0-9]+)$", re.IGNORECASE)
_DIGITS_RE = re.compile(r"^([0-9]+)$")
_LIPIDMAPS_RE = re.compile(r"^(LM[A-Z0-9]+)$", re.IGNORECASE)
_PUBCHEM_RE = re.compile(r"^(?:CID[:_])?([0-9]+)$", re.IGNORECASE)


def _collapse_ws(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def normalize_id(vocabulary: str, raw: str) -> str:
    """Canonicalize a raw identifier for ``vocabulary``.

    Raises ``ValueError`` if the value is empty or malformed for the vocabulary.
    Unknown vocabularies fall back to case-fold + whitespace-collapse (weak but
    non-crashing), per the design doc.
    """
    if raw is None:
        raise ValueError("identifier is None")
    value = _collapse_ws(str(raw))
    if not value:
        raise ValueError("identifier is empty")

    vocab = vocabulary.lower()

    if vocab == "hmdb":
        m = _HMDB_RE.match(value)
        if not m:
            raise ValueError(f"malformed HMDB id: {raw!r}")
        return "HMDB" + m.group(1).zfill(7)

    if vocab == "chebi":
        m = _CHEBI_RE.match(value)
        if not m:
            raise ValueError(f"malformed ChEBI id: {raw!r}")
        return "CHEBI:" + m.group(1)

    if vocab == "lipidmaps":
        m = _LIPIDMAPS_RE.match(value)
        if not m:
            raise ValueError(f"malformed LIPID MAPS id: {raw!r}")
        return m.group(1).upper()

    if vocab == "pubchem":
        m = _PUBCHEM_RE.match(value)
        if not m:
            raise ValueError(f"malformed PubChem id: {raw!r}")
        return m.group(1)

    if vocab in ("ncbigene", "ncbi_gene", "gene"):
        m = _DIGITS_RE.match(value)
        if not m:
            raise ValueError(f"malformed NCBI Gene id: {raw!r}")
        return m.group(1)

    if vocab == "refmet":
        # RefMet is matched at the name grain: case-folded, whitespace-collapsed.
        return value.casefold()

    if vocab in ("uniprot", "ensembl", "kegg"):
        return value.upper()

    # Unknown vocabulary: weak fallback.
    return value.casefold()


def normalize_gt_set(vocabulary: str, raw_ids: list[str]) -> tuple[set[str], bool]:
    """Normalize a ground-truth cell.

    Returns ``(normalized_set, all_malformed)``. ``all_malformed`` is True only when
    at least one raw id was present and every one failed to normalize — the caller
    uses it to emit ``MALFORMED_GROUND_TRUTH``.
    """
    normalized: set[str] = set()
    seen_any = False
    malformed = 0
    total = 0
    for raw in raw_ids:
        if raw is None or not str(raw).strip():
            continue
        seen_any = True
        total += 1
        try:
            normalized.add(normalize_id(vocabulary, raw))
        except ValueError:
            malformed += 1
    all_malformed = seen_any and malformed == total
    return normalized, all_malformed


def assemble_candidates(result: dict, vocabulary: str) -> tuple[list[Candidate], bool]:
    """Build the order-preserving, de-duplicated candidate list for one vocabulary.

    Merges the confidence-ordered ``identifiers`` list with the unscored
    ``kgEquivalentIds`` entries (kg items appended last so they never occupy trusted
    top ranks). Returns ``(candidates, all_malformed)`` where ``all_malformed`` is True
    only when the raw returned list was non-empty and every item failed to normalize
    (drives ``MALFORMED_RETURNED``).
    """
    keys = NAMESPACE_SOURCE_KEYS.get(vocabulary.lower())
    identifiers = result.get("identifiers") or {}
    kg = result.get("kgEquivalentIds") or {}

    raw_ordered: list[tuple[str, str]] = []  # (raw, source)
    if keys:
        for raw in identifiers.get(keys["identifiers"], []) or []:
            raw_ordered.append((raw, SOURCE_IDENTIFIERS))
        for kg_key in keys["kg"]:  # type: ignore[union-attr]
            for raw in kg.get(kg_key, []) or []:
                raw_ordered.append((raw, SOURCE_KG))
    else:
        for raw in identifiers.get(vocabulary.lower(), []) or []:
            raw_ordered.append((raw, SOURCE_IDENTIFIERS))

    candidates: list[Candidate] = []
    seen: set[str] = set()
    raw_present = 0
    malformed = 0
    for raw, source in raw_ordered:
        if raw is None or not str(raw).strip():
            continue
        raw_present += 1
        try:
            norm = normalize_id(vocabulary, raw)
        except ValueError:
            malformed += 1
            continue
        if norm in seen:
            continue
        seen.add(norm)
        candidates.append(Candidate(normalized=norm, raw=str(raw), source=source))

    all_malformed = raw_present > 0 and malformed == raw_present
    return candidates, all_malformed
