"""Input loading, hint building, and ID normalization for the MS1 ↔ Biomapper study.

Shared by the pipeline runner (hints) and the comparison engine (normalized IDs).

Key facts baked in here (see the plan):
- the curated reference IDs are bare values: ChEBI ``174627``, KEGG ``C00152``, PubChem integers,
  HMDB ``HMDB0031059``, LipidMaps ``LMFA...``.
- Biomapper's ``identifiers`` dict is keyed by *vocab* prefixes (``CHEBI``, ``HMDB``,
  ``KEGG.COMPOUND``, ``LIPIDMAPS``, ``PUBCHEM.COMPOUND``, ``refmet_id``) and its
  ``kg_equivalent_ids`` dict uses CURIE prefixes (e.g. LipidMaps is ``LM``). The two
  prefix conventions differ — keep separate maps and confirm against a live key dump.
- ``feature_id`` is NOT unique (15 duplicates over 2,725 rows); join on
  ``(feature_id, matched_name)``.
"""

from __future__ import annotations

import re
from pathlib import Path

import pandas as pd

# --- namespace maps -------------------------------------------------------

# the reference's annotation column -> Biomapper ``identifiers`` vocab prefix.
COLUMN_TO_IDENTIFIERS_PREFIX: dict[str, str] = {
    "hmdb_id": "HMDB",
    "chebi_id": "CHEBI",
    "kegg_id": "KEGG.COMPOUND",
    "lipidmaps_id": "LIPIDMAPS",
    "pubchem_cid": "PUBCHEM.COMPOUND",
}

# The scored ID namespaces (RefMet is handled separately via the master list bridge).
SCORED_NAMESPACES: tuple[str, ...] = tuple(COLUMN_TO_IDENTIFIERS_PREFIX.values())

# Where each scored namespace's IDs may appear across BOTH the sparse ``identifiers`` dict
# (CHEBI + refmet_id only, in practice) and the rich ``kg_equivalent_ids`` dict. Confirmed
# by live key dump: kg_equivalent_ids uses full vocab keys (KEGG.COMPOUND, PUBCHEM.COMPOUND,
# HMDB, CHEBI) EXCEPT LipidMaps, which is keyed ``LM`` with the "LM" prefix stripped from the
# value (e.g. kg['LM'] = 'FA01030036' vs the reference's 'LMFA01030036'). normalize_id reconciles.
NAMESPACE_SOURCE_KEYS: dict[str, tuple[str, ...]] = {
    "HMDB": ("HMDB",),
    "CHEBI": ("CHEBI",),
    "KEGG.COMPOUND": ("KEGG.COMPOUND",),
    "PUBCHEM.COMPOUND": ("PUBCHEM.COMPOUND",),
    "LIPIDMAPS": ("LIPIDMAPS", "LM"),
}

# Biomapper RefMet keys: identifiers['refmet_id'] = ['RM0153615']; kg_equivalent_ids['RM'] = ['0153615'].
REFMET_SOURCE_KEYS: tuple[str, ...] = ("refmet_id", "RM")

# the reference's chemical-class columns (RefMet classification), used for the secondary class axis.
CLASS_COLUMNS: tuple[str, ...] = ("super_class", "main_class", "sub_class")

_MISSING_TOKENS = {"", "na", "n/a", "nan", "none", "null"}


def is_missing(value: object) -> bool:
    """True for empty / NA-like cells. Biomapper's empty ``{}`` is handled elsewhere."""
    if value is None:
        return True
    if isinstance(value, float) and pd.isna(value):
        return True
    return str(value).strip().lower() in _MISSING_TOKENS


def _digits(value: str) -> str | None:
    m = re.findall(r"\d+", value)
    return "".join(m) if m else None


def normalize_id(namespace: str, value: object) -> str | None:
    """Canonicalize an ID for a namespace so reference-format and Biomapper-format compare equal.

    Returns ``None`` for missing/uninterpretable values.
    """
    if is_missing(value):
        return None
    raw = str(value).strip()

    if namespace == "HMDB":
        n = _digits(raw)
        return f"HMDB{int(n):07d}" if n is not None else None

    if namespace == "CHEBI":
        # the reference + Biomapper both bare numbers; tolerate a "CHEBI:" CURIE prefix.
        body = re.sub(r"(?i)^chebi[:_]", "", raw)
        n = _digits(body)
        return str(int(n)) if n is not None else None

    if namespace == "KEGG.COMPOUND":
        body = re.sub(r"(?i)^kegg(\.compound)?[:_]", "", raw).upper()
        return body or None

    if namespace == "PUBCHEM.COMPOUND":
        body = re.sub(r"(?i)^(pubchem(\.compound)?|cid)[:_]", "", raw)
        # PubChem CIDs are integers; coerce float-like strings ("5463.0") safely.
        try:
            return str(int(float(body)))
        except (ValueError, TypeError):
            n = _digits(body)
            return str(int(n)) if n is not None else None

    if namespace == "LIPIDMAPS":
        # Strip a "LIPIDMAPS:" CURIE prefix, then canonicalize to the full LMxxxxxxxx form.
        # Biomapper's kg['LM'] omits the leading "LM" (e.g. 'FA01030036'); the reference has 'LMFA01030036'.
        body = re.sub(r"(?i)^lipidmaps[:_]", "", raw).upper()
        if not body:
            return None
        return body if body.startswith("LM") else f"LM{body}"

    if namespace == "RM":  # RefMet ID -> canonical RMxxxxxxx (7 digits)
        n = _digits(raw)
        return f"RM{int(n):07d}" if n is not None else None

    # Default: trimmed string.
    return raw or None


def normalize_name(value: object) -> str | None:
    """Normalize a compound/RefMet name for string comparison: lowercase, alnum-only."""
    if is_missing(value):
        return None
    norm = re.sub(r"[^a-z0-9]+", "", str(value).lower())
    return norm or None


def biomapper_ids(result: dict, namespace: str) -> set[str]:
    """Union a Biomapper result's IDs for a scored namespace across identifiers + kg_equivalent_ids."""
    identifiers = result.get("identifiers") or {}
    kg = result.get("kg_equivalent_ids") or {}
    out: set[str] = set()
    for key in NAMESPACE_SOURCE_KEYS.get(namespace, (namespace,)):
        out |= normalize_ids(namespace, identifiers.get(key))
        out |= normalize_ids(namespace, kg.get(key))
    return out


def biomapper_refmet_ids(result: dict) -> set[str]:
    """Union a Biomapper result's RefMet IDs, canonicalized to RMxxxxxxx."""
    identifiers = result.get("identifiers") or {}
    kg = result.get("kg_equivalent_ids") or {}
    out: set[str] = set()
    for key in REFMET_SOURCE_KEYS:
        out |= normalize_ids("RM", identifiers.get(key))
        out |= normalize_ids("RM", kg.get(key))
    return out


def normalize_ids(namespace: str, values: list[object] | None) -> set[str]:
    """Normalize a list of IDs (e.g. Biomapper's id list) into a set, dropping Nones."""
    if not values:
        return set()
    return {nid for v in values if (nid := normalize_id(namespace, v)) is not None}


# --- loading --------------------------------------------------------------

_BASE_COLUMNS = ["feature_id", "matched_name", "match_level"]


def load_features(path: str | Path) -> pd.DataFrame:
    """Load the reference's per-metabolite annotations as the master table.

    Reads everything as strings with NA preserved as the literal so ``is_missing`` owns the
    missing-value decision. Warns if any ``feature_id`` repeats with the *same* matched_name
    (which would break the (feature_id, matched_name) join).
    """
    df = pd.read_csv(path, dtype=str, keep_default_na=False, na_filter=False)
    missing = [c for c in _BASE_COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(f"{path}: missing required columns {missing}")

    id_counts = df["feature_id"].value_counts()
    n_dup_ids = int((id_counts > 1).sum())
    if n_dup_ids:
        collide = int(df.duplicated(subset=["feature_id", "matched_name"], keep=False).sum())
        print(
            f"[load_features] {n_dup_ids} feature_id(s) repeat; "
            f"{collide} row(s) collide on (feature_id, matched_name)"
            + ("" if collide == 0 else " — join key is NOT unique!")
        )
    return df


def build_hints(row: pd.Series) -> dict[str, str]:
    """Build a normalized ``{vocab_prefix: id}`` hint dict from a row's curated IDs.

    Returns ``{}`` (never ``None``) for a fully-unannotated row.
    """
    hints: dict[str, str] = {}
    for column, prefix in COLUMN_TO_IDENTIFIERS_PREFIX.items():
        if column not in row:
            continue
        nid = normalize_id(prefix, row[column])
        if nid is not None:
            hints[prefix] = nid
    return hints


def distinct_names(df: pd.DataFrame) -> list[str]:
    """Distinct non-empty matched_names, order-preserving, for deduped mapping."""
    seen: dict[str, None] = {}
    for name in df["matched_name"]:
        if not is_missing(name):
            seen.setdefault(str(name).strip(), None)
    return list(seen)


def count_class_without_id(df: pd.DataFrame) -> int:
    """Count features that have a chemical class but no curated ID (gates the class axis)."""
    id_cols = [c for c in COLUMN_TO_IDENTIFIERS_PREFIX if c in df.columns]
    class_cols = [c for c in CLASS_COLUMNS if c in df.columns]
    if not class_cols:
        return 0
    n = 0
    for _, row in df.iterrows():
        has_class = any(not is_missing(row[c]) for c in class_cols)
        has_id = any(not is_missing(row[c]) for c in id_cols)
        if has_class and not has_id:
            n += 1
    return n
