#!/usr/bin/env python3
"""Name-grain (matched_name) HMDB concordance — the compound-name companion to the feature-grain stats.

BioMapper maps each ``matched_name`` to HMDB once, so BioMapper's output is already name-grain; the
spectral HMDB is a per-feature annotation and many features share a name (758 names over 1,556 features).
This module aggregates the feature-grain tiered table up to the name and characterizes concordance per
distinct compound name, on axes chosen to expose the one-to-many problem rather than average it away.

Per name:
  * ``name_state``           — set-overlap of the union of the features' CLEANEST-tier HMDBs
                               (``best_tier_hmdb``, group_MS2 -> MS2 -> MS1) against the BioMapper union.
                               Using best_tier (not raw all-tier ``spectral_hmdb``) keeps this consistent
                               with the MS1-reliability reframe, under which raw MS2/CURATION states are
                               tier artifacts. This is an ANY-MATCH (permissive) bar — see agreement_fraction.
  * ``agreement_fraction``   — concordant / comparable features (the resolution the any-match state hides).
  * ``consistency``          — single / unanimous / mixed over the COMPARABLE features' ``best_tier_state``
                               (no-biomapper-id features excluded; reported separately as coverage).
  * ``spectral_homogeneous`` — whether the name carries a single distinct best-tier spectral id. State
                               agreement is blind to agreement-via-different-molecules; this surfaces it.

Offline and deterministic: reads ``two_way_comprehensive_tiered.csv`` (produced by ``tier_resolved.py``)
and reuses the cached ``group_character`` / ``group_summary``. No SDK or LLM calls.
"""

from __future__ import annotations

import argparse
import csv
import glob
from pathlib import Path

import pandas as pd

import io_and_normalize as io
from two_way import CONCORDANT, DISAGREE, NO_BIOMAPPER  # shared state vocabulary

# consistency descriptor values
SINGLE = "single"
UNANIMOUS = "unanimous"
MIXED = "mixed"

# a feature is comparable when BioMapper returned an HMDB to agree or disagree with.
COMPARABLE = {CONCORDANT, DISAGREE}

# input columns required from the feature-grain tiered CSV.
REQUIRED_COLUMNS = (
    "matched_name", "best_tier_hmdb", "bmap_hmdb", "best_tier_state",
    "match_level", "comparison_scope", "group_character", "group_summary",
)


def _ids(cell) -> set[str]:
    if io.is_missing(cell):
        return set()
    return {x for x in str(cell).split(";") if x.strip()}


def _first_nonempty(values) -> str:
    for v in values:
        if not io.is_missing(v):
            return str(v)
    return ""


# --- per-name axes ----------------------------------------------------------

def name_state(spectral: set[str], bmap: set[str]) -> str:
    """Set-overlap of the name's best-tier spectral union vs its BioMapper union."""
    if not bmap:
        return NO_BIOMAPPER
    return CONCORDANT if (spectral & bmap) else DISAGREE


def agreement_fraction(best_tier_states: list[str]) -> float | None:
    """Concordant / comparable features; ``None`` when the name has no comparable features."""
    comparable = [s for s in best_tier_states if s in COMPARABLE]
    if not comparable:
        return None
    return sum(1 for s in comparable if s == CONCORDANT) / len(comparable)


def consistency(best_tier_states: list[str]) -> str:
    """``single`` / ``unanimous`` / ``mixed`` over comparable features only; blank if none comparable."""
    comparable = [s for s in best_tier_states if s in COMPARABLE]
    if not comparable:
        return ""
    if len(comparable) == 1:
        return SINGLE
    return UNANIMOUS if len(set(comparable)) == 1 else MIXED


# --- aggregation ------------------------------------------------------------

def build_name_concordance(feature_df: pd.DataFrame) -> pd.DataFrame:
    """Aggregate the feature-grain tiered table to one row per ``matched_name``."""
    rows: list[dict] = []
    for name, grp in feature_df.groupby("matched_name", sort=True):
        spectral: set[str] = set()
        bmap: set[str] = set()
        for cell in grp["best_tier_hmdb"]:
            spectral |= _ids(cell)
        for cell in grp["bmap_hmdb"]:
            bmap |= _ids(cell)
        states = [str(s) for s in grp["best_tier_state"]]
        n_comparable = sum(1 for s in states if s in COMPARABLE)
        n_no_bmap = sum(1 for s in states if s == NO_BIOMAPPER)
        rows.append({
            "matched_name": name,
            "n_features": len(grp),
            "n_spectral_ids": len(spectral),
            "n_bmap_ids": len(bmap),
            "n_comparable_features": n_comparable,
            "n_no_bmap_features": n_no_bmap,
            "name_state": name_state(spectral, bmap),
            "agreement_fraction": agreement_fraction(states),
            "consistency": consistency(states),
            "spectral_homogeneous": len(spectral) == 1,
            "spectral_hmdb": ";".join(sorted(spectral)),
            "bmap_hmdb": ";".join(sorted(bmap)),
            "agreeing_ids": ";".join(sorted(spectral & bmap)),
            "match_levels": "+".join(sorted({str(m).strip() for m in grp["match_level"]
                                             if not io.is_missing(m)})),
            "comparison_scopes": ";".join(sorted({str(c).strip() for c in grp["comparison_scope"]
                                                  if not io.is_missing(c)})),
            "group_character": _first_nonempty(grp["group_character"]),
            "group_summary": _first_nonempty(grp["group_summary"]),
        })
    return pd.DataFrame(rows)


def name_summary(name_df: pd.DataFrame) -> pd.DataFrame:
    """Headline counts: states, concordance% among comparable, and the two coherence tallies."""
    vc = name_df["name_state"].value_counts().to_dict()
    conc, dis, nob = vc.get(CONCORDANT, 0), vc.get(DISAGREE, 0), vc.get(NO_BIOMAPPER, 0)
    comparable = conc + dis
    pct = round(100 * conc / comparable) if comparable else 0
    # unanimous yet multi-spectral: agree on state, differ on identity (the masked inconsistency).
    spectral_heterogeneous = int(((name_df["consistency"] == UNANIMOUS)
                                  & (~name_df["spectral_homogeneous"])).sum())
    agreement_lt_1 = int((name_df["agreement_fraction"].fillna(1.0) < 1.0).sum())
    metrics = [
        ("names", len(name_df)),
        ("concordant", conc),
        ("disagree", dis),
        ("no_biomapper", nob),
        ("comparable", comparable),
        ("concordance_pct", pct),
        ("spectral_heterogeneous", spectral_heterogeneous),
        ("agreement_lt_1", agreement_lt_1),
    ]
    return pd.DataFrame(metrics, columns=["metric", "value"])


# --- CLI: emit name-grain deliverables (offline) ----------------------------

def _read_feature_csv(path: Path) -> pd.DataFrame:
    """Read the tiered CSV, skipping a leading ``# ...`` provenance comment row only when present."""
    with path.open(newline="") as fh:
        first = next(csv.reader(fh), [])
    skip = 1 if (first and str(first[0]).lstrip().startswith("#")) else 0
    df = pd.read_csv(path, skiprows=skip, dtype=str, keep_default_na=False)
    missing = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    if missing:
        raise SystemExit(f"{path}: missing required columns {missing}")
    return df


def _write_csv(comment: str, df: pd.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as fh:
        w = csv.writer(fh)
        if comment:
            w.writerow([comment])
        w.writerow(df.columns)
        for _, r in df.iterrows():
            w.writerow(["" if pd.isna(v) else v for v in r])


_MARKER = ("Name-grain (matched_name) HMDB concordance. name_state by set-overlap of each name's "
           "CLEANEST-tier spectral HMDBs (best_tier_hmdb) vs BioMapper -- an ANY-MATCH upper bound; "
           "agreement_fraction = concordant/comparable features. consistency over comparable best_tier_state; "
           "spectral_homogeneous flags single vs multiple distinct spectral ids. Offline/deterministic.")


def main() -> None:
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser(description="Name-grain concordance from the feature-grain tiered CSV (offline)")
    ap.add_argument("--in", dest="inp", default=None,
                    help="tiered feature CSV (default: outputs/tier-resolved/, else newest outputs/*/)")
    ap.add_argument("--out", default=None, help="output dir (default: alongside the input)")
    args = ap.parse_args()

    if args.inp:
        in_path = Path(args.inp)
    else:
        preferred = here / "outputs" / "tier-resolved" / "two_way_comprehensive_tiered.csv"
        if preferred.exists():
            in_path = preferred
        else:
            cands = sorted(glob.glob(str(here / "outputs" / "*" / "two_way_comprehensive_tiered.csv")))
            if not cands:
                raise SystemExit("no two_way_comprehensive_tiered.csv found under outputs/")
            in_path = Path(cands[-1])
    out_dir = Path(args.out) if args.out else in_path.parent
    out_dir.mkdir(parents=True, exist_ok=True)

    df = _read_feature_csv(in_path)
    print(f"[name_concordance] input: {in_path}  ({len(df)} features)")
    names = build_name_concordance(df)
    summary = name_summary(names)

    print("[name_concordance] name-grain summary:")
    for _, r in summary.iterrows():
        print(f"  {r['metric']:24} {r['value']}")

    csv_out = out_dir / "name_concordance.csv"
    _write_csv(_MARKER, names, csv_out)
    summary.to_csv(out_dir / "name_concordance_summary.csv", index=False)
    print(f"[name_concordance] wrote {csv_out}  ({len(names)} names)")
    print(f"[name_concordance] wrote {out_dir / 'name_concordance_summary.csv'}")


if __name__ == "__main__":
    main()
