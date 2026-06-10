"""Spectral-ID delta: feature-grain three-way HMDB classification + Metabolon export.

Characterizes where the embedded spectral HMDB (Metabolon's MS1/MS2 library hit) diverges from the
Biomapper name-only mapping and the curated reference. Operates at FEATURE/SPECTRUM grain (preserve
multiplicity, never modal-collapse), joining the name-grain comparison.csv on ``matched_name``.

Pipeline (run inline from run_comparison.py):
    build_spectral_delta(comp_df, gt_df, xlsx)  -> per-feature delta rows (three-way state)
    resolve metadata for all competing HMDB IDs (hmdb_api)
    enrich_with_relation(delta_df, meta)        -> deterministic structural_relation per row
    write_metabolon_export(build_metabolon_export(...), path)  -> standalone CSV (PROVISIONAL marker)

Deterministic only (Phase 1) — no LLM. The LLM cause narration (Phase 2) is gated on data-sharing.
"""

from __future__ import annotations

import csv
import re
from pathlib import Path

import pandas as pd

import io_and_normalize as io
import structural_relation as sr
from compare import sanitize_cell
from input_hints import NAME_COLUMNS

_HMDB_RE = re.compile(r"HMDB\d+")
COSINE_COL = "ms1_compound_name"  # provenance default; cosine read from ms1_cosine_score

# Three-way states (curation is a fallible baseline arbiter).
ALL_AGREE = "all-agree"
SPECTRAL_DISAGREES = "spectral-disagrees"
BIOMAPPER_DISAGREES = "biomapper-disagrees"
CURATION_OUTLIER = "curation-outlier-candidate"   # spectral==biomapper, both != curated
ALL_DIFFER = "all-differ"
NO_ARBITER = "no-curated-arbiter"

PROVISIONAL_MARKER = (
    "PROVISIONAL / UNVALIDATED — advisory characterization; clear only after the Unit 7 spot-check. "
    "Contains curated reference IDs — share only via the original channel."
)


def _ids(cell) -> set[str]:
    if io.is_missing(cell):
        return set()
    return {x for x in str(cell).split(";") if x.strip()}


# --- feature-grain embedded extraction ------------------------------------

def build_embedded_by_feature(xlsx_path: str | Path) -> dict[str, dict]:
    """Per feature_id: embedded HMDB IDs (normalized) with max cosine + a provenance sample.

    Preserves multiplicity (does NOT modal-collapse). Returns
    ``{feature_id: {"matched_name": str, "hmdb": {id: {"cosine": float|None, "sheet","col","raw","count"}}}}``.
    """
    xls = pd.ExcelFile(xlsx_path)
    out: dict[str, dict] = {}
    for sheet in xls.sheet_names:
        s = pd.DataFrame(xls.parse(sheet, dtype=str, keep_default_na=False))
        if "feature_id" not in s.columns or "matched_name" not in s.columns:
            continue
        for _, row in s.iterrows():
            fid = str(row.get("feature_id", "")).strip()
            name = str(row.get("matched_name", "")).strip()
            if io.is_missing(fid) or io.is_missing(name):
                continue
            cos = row.get("ms1_cosine_score", "")
            cosine = None
            if not io.is_missing(cos):
                try:
                    cosine = float(str(cos))
                except (TypeError, ValueError):
                    cosine = None
            rec = out.setdefault(fid, {"matched_name": name, "hmdb": {}})
            for col in NAME_COLUMNS:
                raw = str(row.get(col, ""))
                for m in _HMDB_RE.findall(raw):
                    nid = io.normalize_id("HMDB", m)
                    if not nid:
                        continue
                    e = rec["hmdb"].setdefault(nid, {"cosine": None, "sheet": sheet,
                                                      "col": col, "raw": raw[:60], "count": 0})
                    e["count"] += 1
                    if cosine is not None and (e["cosine"] is None or cosine > e["cosine"]):
                        e["cosine"] = cosine
    return out


# --- three-way classification ---------------------------------------------

def classify_three_way(spectral: set[str], bmap: set[str], curated: set[str]) -> str:
    """Classify {spectral, name-only, curated} agreement; curation as fallible arbiter."""
    if not curated:
        return NO_ARBITER
    s_c = bool(spectral & curated)
    b_c = bool(bmap & curated)
    if s_c and b_c:
        return ALL_AGREE
    if b_c and not s_c:
        return SPECTRAL_DISAGREES
    if s_c and not b_c:
        return BIOMAPPER_DISAGREES
    # neither matches curated
    if spectral and bmap and (spectral & bmap):
        return CURATION_OUTLIER  # both automated sources agree against curation → curation may be wrong
    return ALL_DIFFER


# --- delta table -----------------------------------------------------------

def build_spectral_delta(comp: pd.DataFrame, gt_df: pd.DataFrame, xlsx_path: str | Path) -> pd.DataFrame:
    """Feature-grain delta: one row per feature carrying an embedded HMDB, with the three-way state.

    comp (name-grain) supplies name-only/curated HMDB + confidence_tier, joined on matched_name.
    gt_df supplies the curated reference + (presence-only) curation cross-check columns.
    """
    embedded = build_embedded_by_feature(xlsx_path)
    comp_by_name = {str(r["matched_name"]).strip(): r for _, r in comp.iterrows()}
    gt_by_fid = {str(r["feature_id"]).strip(): r for _, r in gt_df.iterrows()}

    rows: list[dict] = []
    for fid, rec in embedded.items():
        name = rec["matched_name"]
        spectral = set(rec["hmdb"])
        if not spectral:
            continue
        c = comp_by_name.get(name)
        bmap = _ids(c["HMDB__bmap"]) if c is not None else set()
        ref = _ids(c["HMDB__ref"]) if c is not None else set()
        conf = (c["confidence_tier"] if c is not None else None)
        # representative spectral id = highest cosine, then sorted
        rep_spectral = max(spectral, key=lambda i: (rec["hmdb"][i]["cosine"] or -1, i))
        prov = rec["hmdb"][rep_spectral]
        gt = gt_by_fid.get(fid)
        rows.append({
            "feature_id": fid,
            "matched_name": name,
            "match_level": (gt["match_level"] if gt is not None and "match_level" in gt else None),
            "confidence_tier": conf,
            "spectral_hmdb": ";".join(sorted(spectral)),
            "spectral_n": len(spectral),
            "spectral_cosine_max": prov["cosine"],
            "spectral_src": f"{prov['sheet']}:{prov['col']}",
            "rep_spectral_id": rep_spectral,
            "bmap_hmdb": ";".join(sorted(bmap)),
            "ref_hmdb": ";".join(sorted(ref)),
            "three_way_state": classify_three_way(spectral, bmap, ref),
            "curation_xref_present": bool(gt is not None and "curation_chemical_id" in gt
                                          and not io.is_missing(gt["curation_chemical_id"])),
        })
    return pd.DataFrame(rows)


# --- deterministic structural relation enrichment --------------------------

def enrich_with_relation(delta: pd.DataFrame, meta: dict[str, dict]) -> pd.DataFrame:
    """Add the deterministic structural relation between the representative spectral ID and the
    'truth' ID (curated if present, else name-only)."""
    out = delta.copy()
    rels, truth_ids = [], []
    for _, r in delta.iterrows():
        spec = r["rep_spectral_id"]
        truth_set = _ids(r["ref_hmdb"]) or _ids(r["bmap_hmdb"])
        truth = sorted(truth_set)[0] if truth_set else None
        truth_ids.append(truth or "")
        rels.append(sr.relation(meta.get(spec), meta.get(truth) if truth else None))
    out["truth_id"] = truth_ids
    out["structural_relation"] = rels
    return out


# --- Metabolon export (rendering layer; Phase-1 deterministic columns) ------

def build_metabolon_export(enriched: pd.DataFrame, meta: dict[str, dict]) -> pd.DataFrame:
    """Compose the shareable per-feature table: identities + official metadata for the competing IDs
    + deterministic relation + a pending LLM-cause placeholder (Phase-2)."""
    def m(hid, field):
        d = meta.get(str(hid))
        return d.get(field) if d else None
    out = enriched.copy()
    for side, idcol in (("spectral", "rep_spectral_id"), ("truth", "truth_id")):
        out[f"{side}_name"] = out[idcol].map(lambda i: m(i, "name"))
        out[f"{side}_formula"] = out[idcol].map(lambda i: m(i, "formula"))
        out[f"{side}_mono_mass"] = out[idcol].map(lambda i: m(i, "monoisotopic_mass"))
        out[f"{side}_inchikey"] = out[idcol].map(lambda i: m(i, "inchikey"))
        out[f"{side}_link"] = out[idcol].map(lambda i: m(i, "link"))
        out[f"{side}_meta_source"] = out[idcol].map(lambda i: m(i, "source"))
    out["llm_cause"] = "pending"        # Phase-2 (gated); stable column + sentinel
    out["llm_adjudication"] = "pending"
    return out


def write_metabolon_export(df: pd.DataFrame, path: str | Path) -> None:
    """Write the export CSV, sanitized, with the PROVISIONAL marker as a leading comment row."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    text_cols = {"matched_name", "spectral_name", "truth_name"}
    with path.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow([f"# {PROVISIONAL_MARKER}"])
        w.writerow(df.columns)
        for _, r in df.iterrows():
            w.writerow([sanitize_cell(v) if c in text_cols else ("" if pd.isna(v) else v)
                        for c, v in zip(df.columns, r)])
