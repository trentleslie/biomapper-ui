"""Unit 3: comparison engine — join Biomapper results to the curated reference IDs and classify.

Authoritative comparison uses the NAME-ONLY pass. Hinted-pass columns are emitted with a
``_hinted`` suffix and are lift-only (never concordance for a hinted namespace).

Per scored namespace each feature is classified:
  agree_exact   both single IDs, equal
  agree_partial sets overlap (>=1 shared), at least one side multi-valued
  disagree      both non-empty, no overlap
  new_coverage  only Biomapper has an ID
  missed        only the reference has an ID
  none          neither has an ID  (split by ``resolved`` so "resolved-no-id" is visible)

RefMet is scored via a master-list bridge (Biomapper refmet_id -> name vs the reference refmet_name).
If the master list is unavailable, RefMet rows are marked ``bridge_unavailable`` (documented fallback).
"""

from __future__ import annotations

import csv
from pathlib import Path

import pandas as pd

import io_and_normalize as io

# Class labels
AGREE_EXACT = "agree_exact"
AGREE_PARTIAL = "agree_partial"
DISAGREE = "disagree"
NEW_COVERAGE = "new_coverage"
MISSED = "missed"
NONE = "none"
BRIDGE_UNAVAILABLE = "bridge_unavailable"


def classify(ref_ids: set[str], bmap_ids: set[str]) -> str:
    """Classify one namespace for one feature from normalized ID sets."""
    if not ref_ids and not bmap_ids:
        return NONE
    if ref_ids and not bmap_ids:
        return MISSED
    if bmap_ids and not ref_ids:
        return NEW_COVERAGE
    overlap = ref_ids & bmap_ids
    if not overlap:
        return DISAGREE
    if len(ref_ids) == 1 and len(bmap_ids) == 1:
        return AGREE_EXACT
    return AGREE_PARTIAL


# --- RefMet bridge --------------------------------------------------------

class RefMetBridge:
    """Maps Biomapper RefMet IDs (RMxxxxxxx) to normalized names, for RefMet concordance."""

    def __init__(self, id_to_name: dict[str, str] | None):
        self._id_to_name = id_to_name or {}
        self.available = bool(id_to_name)

    @classmethod
    def from_data_dir(cls, data_dir: str | Path) -> "RefMetBridge":
        """Load a RefMet master list from data/ if present (refmet_id + refmet_name columns)."""
        data_dir = Path(data_dir)
        for fname in ("refmet.csv", "refmet.tsv", "refmet_master.tsv", "refmet_master.csv"):
            path = data_dir / fname
            if path.exists():
                return cls(cls._parse(path))
        return cls(None)  # unavailable -> fallback

    @staticmethod
    def _parse(path: Path) -> dict[str, str]:
        sep = "\t" if path.suffix == ".tsv" else ","
        df = pd.read_csv(path, sep=sep, dtype=str, keep_default_na=False)
        cols = {c.lower(): c for c in df.columns}
        id_col = cols.get("refmet_id") or cols.get("refmet id")
        name_col = cols.get("refmet_name") or cols.get("name") or cols.get("refmet name")
        if not id_col or not name_col:
            return {}
        out: dict[str, str] = {}
        for _, row in df.iterrows():
            rid = io.normalize_id("RM", row[id_col])
            nm = io.normalize_name(row[name_col])
            if rid and nm:
                out[rid] = nm
        return out

    def classify_feature(self, ref_refmet_name: object, bmap_refmet_ids: set[str]) -> str:
        if not self.available:
            return BRIDGE_UNAVAILABLE
        ref = io.normalize_name(ref_refmet_name)
        bmap_names = {self._id_to_name[i] for i in bmap_refmet_ids if i in self._id_to_name}
        return classify({ref} if ref else set(), bmap_names)


# --- CSV safety -----------------------------------------------------------

def sanitize_cell(value: object) -> str:
    """Prevent CSV formula injection: prefix cells starting with = + - @ with a single quote."""
    s = "" if value is None else str(value)
    return "'" + s if s[:1] in ("=", "+", "-", "@") else s


# --- comparison -----------------------------------------------------------

def _index_by_name(results: list[dict]) -> dict[str, dict]:
    return {str(r.get("query_name")).strip(): r for r in results if r.get("query_name") is not None}


def compare(
    df: pd.DataFrame,
    name_only: list[dict],
    hinted: list[dict] | None,
    bridge: RefMetBridge,
    hints_by_name: dict[str, dict[str, str]] | None = None,
) -> pd.DataFrame:
    """Build the per-feature comparison table (name-only authoritative + hinted lift columns).

    ``hints_by_name`` records which input-side hints were given per feature so the hinted-pass
    columns can mark a namespace circular (``__hinted_here``) only when it was actually hinted.
    Only HMDB among the scored namespaces is ever hintable here (CAS is not scored).
    """
    no_by_name = _index_by_name(name_only)
    hi_by_name = _index_by_name(hinted or [])
    hints_by_name = hints_by_name or {}
    empty: dict = {}
    rows: list[dict] = []

    for _, feat in df.iterrows():
        name = str(feat["matched_name"]).strip()
        res = no_by_name.get(name, empty)
        hres = hi_by_name.get(name, empty)
        feat_hints = hints_by_name.get(name, {})

        row: dict[str, object] = {
            "feature_id": feat["feature_id"],
            "matched_name": feat["matched_name"],
            "match_level": feat["match_level"],
            "resolved": bool(res.get("resolved", False)),
            "confidence_tier": res.get("confidence_tier"),
            "primary_curie": res.get("primary_curie"),
            "hinted_resolved": bool(hres.get("resolved", False)),
        }

        for ns in io.SCORED_NAMESPACES:
            col = _column_for(ns)
            ref_ids = io.normalize_ids(ns, [feat.get(col)])
            bmap_ids = io.biomapper_ids(res, ns)
            row[f"{ns}__ref"] = ";".join(sorted(ref_ids))
            row[f"{ns}__bmap"] = ";".join(sorted(bmap_ids))
            row[f"{ns}__class"] = classify(ref_ids, bmap_ids)
            row[f"{ns}__card"] = len(bmap_ids)
            # hinted: class only, for cross-namespace lift. A namespace is "hinted_here" (and
            # thus circular, excluded from hinted concordance) only if it was actually supplied
            # as a hint for this feature — i.e. HMDB when an HMDB hint was given.
            row[f"{ns}__class_hinted"] = classify(ref_ids, io.biomapper_ids(hres, ns))
            row[f"{ns}__hinted_here"] = ns in feat_hints

        # RefMet (name-bridge)
        ref_refmet = feat.get("refmet_name")
        row["refmet__ref"] = "" if io.is_missing(ref_refmet) else str(ref_refmet)
        row["refmet__class"] = bridge.classify_feature(ref_refmet, io.biomapper_refmet_ids(res))
        row["refmet__bmap_ids"] = ";".join(sorted(io.biomapper_refmet_ids(res)))

        rows.append(row)

    return pd.DataFrame(rows)


def _column_for(namespace: str) -> str:
    for col, ns in io.COLUMN_TO_IDENTIFIERS_PREFIX.items():
        if ns == namespace:
            return col
    raise KeyError(namespace)


def build_mapped_final(df: pd.DataFrame, name_only: list[dict]) -> pd.DataFrame:
    """UI-style export: ALL original input columns preserved, Biomapper's name-only mappings
    appended with a ``_biomapper`` suffix (parallel to the original ID columns).

    Mirrors the biomapper-ui behavior of suffixing generated columns when originals are
    present, joined to source rows by the entity-name column.
    """
    by_name = _index_by_name(name_only)
    out = df.copy()
    appended: dict[str, list] = {
        "resolved_biomapper": [],
        "primary_curie_biomapper": [],
        "confidence_tier_biomapper": [],
        "confidence_score_biomapper": [],
        "refmet_id_biomapper": [],
    }
    for col in io.COLUMN_TO_IDENTIFIERS_PREFIX:  # hmdb_id_biomapper, chebi_id_biomapper, ...
        appended[f"{col}_biomapper"] = []

    for _, feat in df.iterrows():
        res = by_name.get(str(feat["matched_name"]).strip(), {})
        appended["resolved_biomapper"].append(bool(res.get("resolved", False)))
        appended["primary_curie_biomapper"].append(res.get("primary_curie"))
        appended["confidence_tier_biomapper"].append(res.get("confidence_tier"))
        appended["confidence_score_biomapper"].append(res.get("confidence_score"))
        appended["refmet_id_biomapper"].append(";".join(sorted(io.biomapper_refmet_ids(res))))
        for col, ns in io.COLUMN_TO_IDENTIFIERS_PREFIX.items():
            appended[f"{col}_biomapper"].append(";".join(sorted(io.biomapper_ids(res, ns))))

    for c, vals in appended.items():
        out[c] = vals
    return out


def write_mapped_final(df_out: pd.DataFrame, path: str | Path) -> None:
    """Write the mapped-final CSV, sanitizing every cell against formula injection."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(df_out.columns)
        for _, r in df_out.iterrows():
            w.writerow([sanitize_cell("" if pd.isna(v) else v) for v in r])


def write_comparison(df_out: pd.DataFrame, path: str | Path) -> None:
    """Write the comparison CSV with formula-injection sanitization on text cells."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    text_cols = {"matched_name", "refmet__ref"}
    with path.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(df_out.columns)
        for _, r in df_out.iterrows():
            w.writerow([
                sanitize_cell(v) if c in text_cols else ("" if pd.isna(v) else v)
                for c, v in zip(df_out.columns, r)
            ])
