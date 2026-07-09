#!/usr/bin/env python3
"""Tier-resolved concordance: spectral↔Biomapper agreement cut by HMDB *source* tier.

Two valid tier cuts answer different questions — do not conflate them:

  * match_level (the feature CALL tier) — the tier of the feature's FINAL identification.
    MS1 features are the headline; MS2/CURATION ``disagree`` rows are mostly tier artifacts
    (the extracted HMDB lives on the MS1 annotation, which was superseded by a higher-tier
    call that records identity with Metabolon's internal id, not an HMDB). See guide FAQ 2.

  * HMDB SOURCE tier (this module) — which spectral column the embedded HMDB id was read
    from: ``ms1_compound_name`` / ``ms2_compound_name`` / ``group_ms2_compound_name``. At
    each tier independently we ask, with SET OVERLAP, whether any of the feature's tier-T
    HMDB ids matches any of Biomapper's HMDB ids for that feature. Concordance RISES with
    source tier (MS1 61% → MS2 74% → group_MS2 78%): higher-tier annotations are cleaner
    cross-references. ``best_tier_*`` rolls each feature up to its cleanest available tier
    (group_MS2 → MS2 → MS1), so a feature's apparent MS1 mismatch is resolved when a higher
    tier agrees (8 of the 24 features carrying both).

Everything here is OFFLINE and DETERMINISTIC — no SDK, no LLM. Per-tier ids come from the
xlsx; each feature's Biomapper id set is taken verbatim from the already-resolved comprehensive
table (joined by ``feature_id``), so the cut is internally consistent with that deliverable.
Curation contributes no HMDB and is intentionally absent.
"""

from __future__ import annotations

import argparse
import csv
import glob
import re
from pathlib import Path

import pandas as pd

import io_and_normalize as io
from two_way import CONCORDANT, DISAGREE, NO_BIOMAPPER  # reuse shared state vocabulary

# Feature has no embedded HMDB at this source tier (nothing to compare).
NO_TIER = "no-tier-hmdb"

_HMDB_RE = re.compile(r"HMDB\d+")

# source tier -> the xlsx column its HMDB id is embedded in.
TIER_COLUMNS = {
    "ms1": "ms1_compound_name",
    "ms2": "ms2_compound_name",
    "group_ms2": "group_ms2_compound_name",
}
TIER_ORDER = ("ms1", "ms2", "group_ms2")           # ascending reliability
BEST_TIER_PREFERENCE = ("group_ms2", "ms2", "ms1")  # cleanest available first


def _ids(cell) -> set[str]:
    if io.is_missing(cell):
        return set()
    return {x for x in str(cell).split(";") if x.strip()}


# --- per-feature per-tier extraction ---------------------------------------

def build_tier_hmdb_by_feature(xlsx_path: str | Path) -> dict[str, dict[str, set[str]]]:
    """Per ``feature_id``: the set of normalized HMDB ids embedded at each source tier.

    Unions across method sheets (a feature can recur on several sheets). Preserves
    multiplicity (a tier may carry >1 distinct id). Returns
    ``{feature_id: {"ms1": set, "ms2": set, "group_ms2": set}}``.
    """
    xls = pd.ExcelFile(xlsx_path)
    out: dict[str, dict[str, set[str]]] = {}
    for sheet in xls.sheet_names:
        s = pd.DataFrame(xls.parse(sheet, dtype=str, keep_default_na=False))
        if "feature_id" not in s.columns:
            continue
        for _, row in s.iterrows():
            fid = str(row.get("feature_id", "")).strip()
            if io.is_missing(fid):
                continue
            rec = out.setdefault(fid, {t: set() for t in TIER_COLUMNS})
            for tier, col in TIER_COLUMNS.items():
                for m in _HMDB_RE.findall(str(row.get(col, ""))):
                    nid = io.normalize_id("HMDB", m)
                    if nid:
                        rec[tier].add(nid)
    return out


# --- per-tier state + best-tier rollup -------------------------------------

def tier_state(tier_ids: set[str], bmap_ids: set[str]) -> str:
    """Set-overlap state at one source tier vs the feature's Biomapper id set."""
    if not tier_ids:
        return NO_TIER
    if not bmap_ids:
        return NO_BIOMAPPER
    return CONCORDANT if (tier_ids & bmap_ids) else DISAGREE


def best_tier(feature_tiers: dict[str, set[str]]) -> tuple[str | None, set[str]]:
    """The cleanest available source tier (group_MS2 → MS2 → MS1) and its id set."""
    for tier in BEST_TIER_PREFERENCE:
        ids = feature_tiers.get(tier) or set()
        if ids:
            return tier, ids
    return None, set()


# --- column augmentation ----------------------------------------------------

def add_tier_columns(df: pd.DataFrame, xlsx_path: str | Path,
                     bmap_col: str = "bmap_hmdb", fid_col: str = "feature_id") -> pd.DataFrame:
    """Append per-tier and best-tier columns to a feature-grain comprehensive frame.

    Biomapper ids are read per-feature from ``bmap_col`` (already resolved upstream); per-tier
    spectral ids are read from the xlsx and joined by ``fid_col``. Adds, for each tier T in
    ``TIER_ORDER``: ``{T}_hmdb`` (``;``-joined sorted ids) and ``{T}_state``; plus
    ``best_tier`` / ``best_tier_hmdb`` / ``best_tier_state`` / ``best_tier_n`` (multiplicity).
    """
    tiers_by_fid = build_tier_hmdb_by_feature(xlsx_path)
    out = df.copy()
    cols: dict[str, list] = {}
    for tier in TIER_ORDER:
        cols[f"{tier}_hmdb"] = []
        cols[f"{tier}_state"] = []
    for c in ("best_tier", "best_tier_hmdb", "best_tier_state", "best_tier_n"):
        cols[c] = []

    for _, r in df.iterrows():
        fid = str(r[fid_col]).strip()
        ft = tiers_by_fid.get(fid, {t: set() for t in TIER_COLUMNS})
        bmap = _ids(r.get(bmap_col))
        for tier in TIER_ORDER:
            ids = ft.get(tier, set())
            cols[f"{tier}_hmdb"].append(";".join(sorted(ids)))
            cols[f"{tier}_state"].append(tier_state(ids, bmap))
        bt, bt_ids = best_tier(ft)
        cols["best_tier"].append(bt or "")
        cols["best_tier_hmdb"].append(";".join(sorted(bt_ids)))
        cols["best_tier_state"].append(tier_state(bt_ids, bmap))
        cols["best_tier_n"].append(len(bt_ids))

    for name, values in cols.items():
        out[name] = values
    return out


# --- summaries (pure DataFrame functions over the augmented columns) --------

def tier_summary(df: pd.DataFrame) -> pd.DataFrame:
    """Per source tier: features w/ HMDB, biomapper-comparable, concordant, disagree, concordance%.

    ``comparable`` = concordant + disagree (i.e. the feature carries a tier-T HMDB *and*
    Biomapper also returned an HMDB). ``concordance_pct`` = round(concordant / comparable * 100).
    """
    rows = []
    for tier in TIER_ORDER:
        col = f"{tier}_state"
        vc = df[col].value_counts().to_dict() if col in df.columns else {}
        conc, dis, nob = vc.get(CONCORDANT, 0), vc.get(DISAGREE, 0), vc.get(NO_BIOMAPPER, 0)
        with_hmdb = conc + dis + nob
        comparable = conc + dis
        pct = round(100 * conc / comparable) if comparable else 0
        rows.append({"tier": tier, "with_hmdb": with_hmdb, "no_biomapper": nob,
                     "comparable": comparable, "concordant": conc, "disagree": dis,
                     "concordance_pct": pct})
    return pd.DataFrame(rows)


def cross_tier_resolved(df: pd.DataFrame) -> dict[str, int]:
    """How often using the right tier fixes an apparent MS1 mismatch.

    ``both_ms1_and_higher``: features carrying an MS1 HMDB *and* an MS2/group_MS2 HMDB
    (both Biomapper-comparable). ``ms1_disagree_higher_agree``: of those, the count where MS1
    disagrees with Biomapper but the higher tier concordant — the tier artifact resolves.
    """
    comparable = {CONCORDANT, DISAGREE}
    both = resolved = 0
    for _, r in df.iterrows():
        ms1 = r.get("ms1_state")
        higher = {r.get("ms2_state"), r.get("group_ms2_state")}
        if ms1 in comparable and higher & comparable:
            both += 1
            if ms1 == DISAGREE and CONCORDANT in higher:
                resolved += 1
    return {"both_ms1_and_higher": both, "ms1_disagree_higher_agree": resolved}


# --- guide HTML section -----------------------------------------------------

TIER_LABELS = {"ms1": "MS1", "ms2": "MS2", "group_ms2": "group_MS2"}
_SECTION_START = "<!-- tier-resolved:source-tier:start -->"
_SECTION_END = "<!-- tier-resolved:source-tier:end -->"


def tier_section_html(summary: pd.DataFrame, cross: dict[str, int]) -> str:
    """A self-contained guide section (source-tier bar chart + table), mirroring the call-tier
    chart's markup. Distinguishes the SOURCE-tier cut from the existing match_level cut."""
    s = {r["tier"]: r for _, r in summary.iterrows()}
    bars = []
    for tier in TIER_ORDER:
        r = s[tier]
        conc, dis, nob = r["concordant"], r["disagree"], r["no_biomapper"]
        total = conc + dis + nob or 1
        seg = (f'<div class="seg c" style="width:{100*conc/total:.1f}%">{conc}</div>'
               f'<div class="seg d" style="width:{100*dis/total:.1f}%">{dis}</div>'
               f'<div class="seg n" style="width:{100*nob/total:.1f}%">{nob}</div>')
        bars.append(
            f'    <div class="barrow"><span class="lbl">{TIER_LABELS[tier]} · {int(r["with_hmdb"])}</span>\n'
            f'      <div class="bar">{seg}</div>\n'
            f'      <span class="rate">{int(r["concordance_pct"])}% concordant*</span></div>')
    table = "\n".join(
        f'  <tr><td class="col">{TIER_LABELS[t]}</td><td>{int(s[t]["concordant"])}</td>'
        f'<td>{int(s[t]["disagree"])}</td><td>{int(s[t]["concordance_pct"])}%</td></tr>'
        for t in TIER_ORDER)
    return f"""{_SECTION_START}
<div class="faq" id="source-tier">
  <h4>2b. Concordance by the HMDB's <i>source</i> tier (a different cut from match_level)</h4>
  <p>FAQ 2 cut by the feature's <b>final-call</b> tier (<code>match_level</code>). This cuts the other
  way — by <b>which spectral column the embedded HMDB id was read from</b>: <code>ms1_compound_name</code>,
  <code>ms2_compound_name</code>, or <code>group_ms2_compound_name</code>. A feature is concordant at a
  source tier if <b>any</b> of its tier-T HMDB ids matches <b>any</b> of Biomapper's ids (set overlap).
  Concordance <b>rises</b> with the source tier — higher-tier annotations are cleaner cross-references:</p>
  <div class="bars">
{chr(10).join(bars)}
    <div class="barlegend">
      <span><i style="background:#2f855a"></i>concordant</span>
      <span><i style="background:#c05621"></i>disagree</span>
      <span><i style="background:#cbd2dc"></i>no Biomapper HMDB</span>
      <span style="margin-left:auto">bars normalized within each tier · *of features Biomapper also mapped</span>
    </div>
  </div>
  <table style="max-width:560px">
  <tr><th>source tier</th><th>concordant</th><th>disagree</th><th>concordance*</th></tr>
{table}
  </table>
  <p class="note">*concordant ÷ (concordant + disagree). The embedded HMDB lives almost entirely on the MS1
  annotation (it is present at MS2 / group_MS2 for only a few dozen features), so MS1 dominates the volume;
  curation carries no HMDB and is absent here.</p>
  <p>Using the <i>right</i> tier resolves apparent MS1 mismatches: of the {cross['both_ms1_and_higher']}
  features carrying both an MS1 and a higher-tier HMDB, <b>{cross['ms1_disagree_higher_agree']}</b> show an
  MS1 <code>disagree</code> that becomes <code>concordant</code> at the higher tier. The
  <code>best_tier_*</code> columns roll each feature up to its cleanest available tier
  (group_MS2 → MS2 → MS1) for a one-row-per-feature comparison.</p>
  <p class="how"><b>Look at →</b> <span class="pill">best_tier_state</span> for the cleanest per-feature
  call; <span class="pill">ms1_state</span> / <span class="pill">ms2_state</span> /
  <span class="pill">group_ms2_state</span> for the individual tiers.</p>
</div>
{_SECTION_END}
"""


def inject_guide_section(guide_text: str, section_html: str) -> str:
    """Insert the source-tier section immediately after the call-tier FAQ (the ``id="tier"`` div).

    Idempotent: a prior section (delimited by the comment markers) is replaced exactly, so
    re-running never duplicates or accumulates cruft.
    """
    existing = re.search(re.escape(_SECTION_START) + r".*?" + re.escape(_SECTION_END),
                         guide_text, re.DOTALL)
    if existing:
        return guide_text[:existing.start()] + section_html.strip("\n") + guide_text[existing.end():]
    # find the end of the call-tier div (id="tier") and insert right after it.
    anchor = guide_text.find('<div class="faq" id="tier">')
    if anchor == -1:
        return guide_text  # nothing to anchor to; leave untouched
    close = guide_text.find("\n</div>", anchor)
    if close == -1:
        return guide_text
    insert_at = close + len("\n</div>\n")
    return guide_text[:insert_at] + "\n" + section_html + guide_text[insert_at:]


# --- CLI: augment an existing comprehensive deliverable (offline) -----------

def _read_comprehensive(path: Path) -> tuple[str, pd.DataFrame]:
    """Read the comprehensive CSV, returning (leading_comment_text_or_'', frame).

    The deliverable's first row is a single quoted ``# ...`` marker field; parse it via csv so
    the unquoted text round-trips. If absent, comment is '' and all rows are data.
    """
    with path.open(newline="") as fh:
        first = next(csv.reader(fh), [])
    if first and str(first[0]).lstrip().startswith("#"):
        return first[0], pd.read_csv(path, skiprows=1)
    return "", pd.read_csv(path)


def _write_comprehensive(comment: str, df: pd.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as fh:
        w = csv.writer(fh)
        if comment:
            w.writerow([comment])
        w.writerow(df.columns)
        for _, r in df.iterrows():
            w.writerow(["" if pd.isna(v) else v for v in r])


def main() -> None:
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser(description="Fold tier-resolved concordance into the deliverables (offline)")
    ap.add_argument("--comprehensive", type=str, default=None,
                    help="path to two_way_comprehensive.csv (default: newest under outputs/)")
    ap.add_argument("--xlsx", type=str, default=str(here / "data" / "All_Methods_Features.xlsx"))
    ap.add_argument("--out", type=str, default=None,
                    help="output dir (default: alongside the input comprehensive CSV)")
    args = ap.parse_args()

    comp_path = Path(args.comprehensive) if args.comprehensive else Path(sorted(
        glob.glob(str(here / "outputs" / "*" / "two_way_comprehensive.csv")))[-1])
    out_dir = Path(args.out) if args.out else comp_path.parent
    out_dir.mkdir(parents=True, exist_ok=True)

    comment, df = _read_comprehensive(comp_path)
    print(f"[tier_resolved] input: {comp_path}  ({len(df)} features)")
    augmented = add_tier_columns(df, args.xlsx)

    summary = tier_summary(augmented)
    cross = cross_tier_resolved(augmented)
    print("[tier_resolved] source-tier concordance:")
    for _, r in summary.iterrows():
        print(f"  {r['tier']:9} with_hmdb={int(r['with_hmdb']):5} comparable={int(r['comparable']):4} "
              f"concordant={int(r['concordant']):4} disagree={int(r['disagree']):4} -> {int(r['concordance_pct'])}%")
    print(f"  cross-tier: {cross['both_ms1_and_higher']} carry MS1+higher; "
          f"{cross['ms1_disagree_higher_agree']} MS1-disagree resolve at a higher tier")

    csv_out = out_dir / "two_way_comprehensive_tiered.csv"
    _write_comprehensive(comment, augmented, csv_out)
    summary.to_csv(out_dir / "tier_concordance_summary.csv", index=False)
    print(f"[tier_resolved] wrote {csv_out}")
    print(f"[tier_resolved] wrote {out_dir / 'tier_concordance_summary.csv'}")

    guide_path = comp_path.parent / "two_way_comprehensive_guide.html"
    if guide_path.exists():
        patched = inject_guide_section(guide_path.read_text(), tier_section_html(summary, cross))
        guide_out = out_dir / "two_way_comprehensive_guide.html"
        guide_out.write_text(patched)
        print(f"[tier_resolved] wrote {guide_out} (tier section injected)")


if __name__ == "__main__":
    main()
