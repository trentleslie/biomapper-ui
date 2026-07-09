"""Two-way spectral <-> Biomapper HMDB comparison (curated-free).

Compares, per feature, Metabolon's embedded SPECTRAL HMDB id(s) against BIOMAPPER's name-only HMDB
mapping for the same ``matched_name``. No curated reference is involved.

Chain under test:
    spectral HMDB id --(Metabolon name-derivation)--> matched_name --(Biomapper name->id)--> biomapper HMDB id

When spectral != biomapper the discrepancy is localized to one of two steps:
  * ``biomapper_mapping``  - Biomapper mapped the name to the wrong/different id
  * ``name_derivation``    - the embedded spectral id and the assigned matched_name already disagree
                             upstream (before Biomapper sees anything)

Deterministic layer here: the two-way state, the chemical ``structural_relation`` between the
competing ids, and a WEAK name-match hint (string-only, unreliable on its own - Metabolon names
differ from HMDB official names ~half the time even when ids agree; see calibration). The actual
fault localization is delegated to the LLM (synonym-aware) in ``llm_characterize``.
"""

from __future__ import annotations

import csv
import re
from pathlib import Path

import pandas as pd

import io_and_normalize as io
import structural_relation as sr
from compare import sanitize_cell
from spectral_delta import build_embedded_by_feature

# Two-way states (no curated arbiter).
CONCORDANT = "concordant"          # spectral id(s) overlap biomapper id(s)
DISAGREE = "disagree"              # both sides have ids, zero overlap
NO_BIOMAPPER = "no-biomapper-id"   # biomapper returned no HMDB id for the name
NO_SPECTRAL = "no-spectral-id"     # no embedded spectral HMDB (not built here; for completeness)

# Weak, string-only name-match hint between a spectral id's official HMDB name and matched_name.
NAME_EXACT = "exact"
NAME_FUZZY = "fuzzy"
NAME_NONE = "none"
NAME_NO_META = "no_meta"

PROVISIONAL_MARKER = (
    "PROVISIONAL / UNVALIDATED - two-way spectral<->Biomapper characterization (no curated reference). "
    "structural_relation is deterministic; name_match_hint is a WEAK string signal (~52% on concordant "
    "features); fault localization is advisory (LLM)."
)


def _ids(cell) -> set[str]:
    if io.is_missing(cell):
        return set()
    return {x for x in str(cell).split(";") if x.strip()}


def _norm(s: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower()) if isinstance(s, str) else ""


def _toks(s: str | None) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", s.lower())) if isinstance(s, str) else set()


def name_match_hint(official: str | None, matched: str | None) -> str:
    """Weak string-only signal: does a spectral id's official HMDB name resemble matched_name?

    NOT a reliable localizer on its own - Metabolon naming differs from HMDB official names even when
    the ids provably agree. Provided only as supporting context for the LLM and human review.
    """
    if not official or not matched:
        return NAME_NO_META
    if _norm(official) == _norm(matched):
        return NAME_EXACT
    a, b = _toks(official), _toks(matched)
    if a and b and len(a & b) / len(a | b) >= 0.6:
        return NAME_FUZZY
    return NAME_NONE


# Deterministic fault localization (only attempted on `disagree` features with metadata on both sides).
FAULT_NAME_DERIVATION = "name_derivation"      # biomapper name == matched_name, spectral name != it
FAULT_BIOMAPPER = "biomapper_mapping"          # spectral name == matched_name, biomapper name != it
FAULT_BOTH_DRIFT = "both_drift"                # neither official name matches matched_name -> LLM
FAULT_ID_SYNONYM = "id_synonym"                # both names match (same compound, different accession)
FAULT_UNDETERMINED = "undetermined"            # missing metadata on a side


def localize(spectral_name_hit: str, bmap_name_hit: str) -> str:
    """Localize a disagreement from which side's OFFICIAL name matches matched_name.

    Each arg is a name_match_hint (exact/fuzzy/none/no_meta). Biomapper maps matched_name -> id, so
    if biomapper's official name reproduces matched_name but the spectral id's name does not, the
    break is upstream (name_derivation); the converse points at biomapper's mapping.
    """
    s_ok = spectral_name_hit in (NAME_EXACT, NAME_FUZZY)
    b_ok = bmap_name_hit in (NAME_EXACT, NAME_FUZZY)
    if spectral_name_hit == NAME_NO_META or bmap_name_hit == NAME_NO_META:
        return FAULT_UNDETERMINED
    if b_ok and not s_ok:
        return FAULT_NAME_DERIVATION
    if s_ok and not b_ok:
        return FAULT_BIOMAPPER
    if s_ok and b_ok:
        return FAULT_ID_SYNONYM
    return FAULT_BOTH_DRIFT


def two_way_state(spectral: set[str], bmap: set[str]) -> str:
    if not spectral:
        return NO_SPECTRAL
    if not bmap:
        return NO_BIOMAPPER
    return CONCORDANT if (spectral & bmap) else DISAGREE


def build_two_way(comp: pd.DataFrame, xlsx_path: str | Path) -> pd.DataFrame:
    """Feature-grain two-way delta: spectral id(s) vs Biomapper id(s), joined on matched_name.

    Preserves spectral multiplicity (``spectral_n`` / ``spectral_ambiguous``). ``comp`` (name-grain)
    supplies Biomapper's HMDB ids + confidence_tier via ``matched_name``.
    """
    embedded = build_embedded_by_feature(xlsx_path)
    comp_by_name = {str(r["matched_name"]).strip(): r for _, r in comp.iterrows()}

    rows: list[dict] = []
    for fid, rec in embedded.items():
        name = rec["matched_name"]
        spectral = set(rec["hmdb"])
        if not spectral:
            continue
        c = comp_by_name.get(name)
        bmap = _ids(c["HMDB__bmap"]) if c is not None else set()
        conf = (c["confidence_tier"] if c is not None else None)
        rep_spectral = max(spectral, key=lambda i: (rec["hmdb"][i]["cosine"] or -1, i))
        prov = rec["hmdb"][rep_spectral]
        rep_bmap = sorted(bmap)[0] if bmap else ""
        # which specific spectral ids agree with biomapper (per-feature, all ids)
        agreeing = sorted(spectral & bmap)
        rows.append({
            "feature_id": fid,
            "matched_name": name,
            "confidence_tier": conf,
            "spectral_hmdb": ";".join(sorted(spectral)),
            "spectral_n": len(spectral),
            "spectral_ambiguous": len(spectral) > 1,
            "spectral_cosine_max": prov["cosine"],
            "spectral_src": f"{prov['sheet']}:{prov['col']}",
            "mean_mz": rec.get("mean_mz"),
            "neutral_mass": rec.get("neutral_mass"),
            "adduct_type": rec.get("adduct_type"),
            "rep_spectral_id": rep_spectral,
            "bmap_hmdb": ";".join(sorted(bmap)),
            "bmap_n": len(bmap),
            "rep_bmap_id": rep_bmap,
            "agreeing_ids": ";".join(agreeing),
            "two_way_state": two_way_state(spectral, bmap),
        })
    return pd.DataFrame(rows)


def enrich_with_relation(delta: pd.DataFrame, meta: dict[str, dict]) -> pd.DataFrame:
    """Add the deterministic structural_relation between the representative spectral and biomapper ids,
    plus the weak name_match_hint (spectral official name vs matched_name)."""
    out = delta.copy()
    rank = {NAME_EXACT: 3, NAME_FUZZY: 2, NAME_NONE: 1, NAME_NO_META: 0}
    rels, spec_hints, bmap_hints, faults = [], [], [], []
    for _, r in delta.iterrows():
        spec, bmap = r["rep_spectral_id"], r["rep_bmap_id"]
        rels.append(sr.relation(meta.get(spec), meta.get(bmap) if bmap else None))
        # best spectral-side hint across all of this feature's spectral ids
        s_best = NAME_NO_META
        for sid in _ids(r["spectral_hmdb"]):
            d = meta.get(sid)
            h = name_match_hint(d.get("name") if d else None, r["matched_name"])
            if rank[h] > rank[s_best]:
                s_best = h
        # biomapper-side hint (representative id)
        bd = meta.get(bmap) if bmap else None
        b_hint = name_match_hint(bd.get("name") if bd else None, r["matched_name"])
        spec_hints.append(s_best)
        bmap_hints.append(b_hint)
        faults.append(localize(s_best, b_hint) if r["two_way_state"] == DISAGREE else "")
    out["structural_relation"] = rels
    out["spectral_name_hint"] = spec_hints
    out["bmap_name_hint"] = bmap_hints
    out["fault_locus_deterministic"] = faults
    return out


# --- export -----------------------------------------------------------------

def build_export(enriched: pd.DataFrame, meta: dict[str, dict]) -> pd.DataFrame:
    """Shareable per-feature table: spectral + biomapper identities & official metadata, the
    deterministic relation, the weak name hint, and (pending) LLM fault-localization columns."""
    def m(hid, field):
        d = meta.get(str(hid))
        return d.get(field) if d else None
    out = enriched.copy()
    for side, idcol in (("spectral", "rep_spectral_id"), ("bmap", "rep_bmap_id")):
        out[f"{side}_name"] = out[idcol].map(lambda i: m(i, "name"))
        out[f"{side}_formula"] = out[idcol].map(lambda i: m(i, "formula"))
        out[f"{side}_mono_mass"] = out[idcol].map(lambda i: m(i, "monoisotopic_mass"))
        out[f"{side}_inchikey"] = out[idcol].map(lambda i: m(i, "inchikey"))
        out[f"{side}_link"] = out[idcol].map(lambda i: m(i, "link"))
        out[f"{side}_meta_source"] = out[idcol].map(lambda i: m(i, "source"))
    for c in ("llm_fault_locus", "llm_recommended_id", "llm_category", "llm_confidence", "llm_rationale"):
        out[c] = enriched[c] if c in enriched.columns else "pending"
    return out


def write_export(df: pd.DataFrame, path: str | Path) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    text_cols = {"matched_name", "spectral_name", "bmap_name", "llm_rationale"}
    with path.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow([f"# {PROVISIONAL_MARKER}"])
        w.writerow(df.columns)
        for _, r in df.iterrows():
            w.writerow([sanitize_cell(v) if c in text_cols else ("" if pd.isna(v) else v)
                        for c, v in zip(df.columns, r)])
