"""Deterministic structural relation between two competing HMDB IDs — no LLM.

From the official metadata (Unit 2) decide how two IDs relate:
- same InChIKey skeleton (first block) → ``same_structure``
- differing InChIKey + same molecular formula → ``isomer``
- differing formula + monoisotopic masses within tolerance → ``isobaric``
- either side missing InChIKey → ``undetermined`` (never guess)
- otherwise → ``unrelated``

InChIKey/formula/mass come only from Unit 2 (the curated file's inchi_key is empty), so coverage is
bounded by MW+PubChem hit rate. The isobar branch refuses cross-source masses (precision differs by
endpoint) — both masses must carry the same ``source``.
"""

from __future__ import annotations

SAME_STRUCTURE = "same_structure"
ISOMER = "isomer"
ISOBARIC = "isobaric"
UNRELATED = "unrelated"
UNDETERMINED = "undetermined"
UNDETERMINED_NO_META = "undetermined_no_metadata"

# Isobar tolerance on monoisotopic mass (Da). Differing-formula compounds within this window count
# as isobaric. Default chosen for nominal-mass-class confusions; tune from the actual mass histogram.
ISOBAR_TOL_DA = 0.05


def _inchikey_block(inchikey: str | None) -> str | None:
    if not inchikey:
        return None
    return str(inchikey).strip().split("-", 1)[0] or None  # 14-char skeleton block


def _mass(meta: dict) -> float | None:
    v = meta.get("monoisotopic_mass")
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def relation(meta_a: dict | None, meta_b: dict | None, *, tol_da: float = ISOBAR_TOL_DA) -> str:
    """Classify the structural relation between two metadata dicts (Unit 2 output)."""
    if not meta_a or not meta_b:
        return UNDETERMINED_NO_META

    ik_a, ik_b = _inchikey_block(meta_a.get("inchikey")), _inchikey_block(meta_b.get("inchikey"))
    if ik_a is None or ik_b is None:
        return UNDETERMINED_NO_META
    if ik_a == ik_b:
        return SAME_STRUCTURE

    fa, fb = (meta_a.get("formula") or None), (meta_b.get("formula") or None)
    if fa and fb and fa == fb:
        return ISOMER

    ma, mb = _mass(meta_a), _mass(meta_b)
    if ma is not None and mb is not None:
        # Refuse a cross-source mass comparison (endpoint precision differs).
        if meta_a.get("source") == meta_b.get("source") and abs(ma - mb) <= tol_da:
            return ISOBARIC
    return UNRELATED
