#!/usr/bin/env python3
"""Unit 5: orchestrator — run both passes, compare, and report, persisting everything.

Usage (from this directory, with the biomapper venv):
    python run_comparison.py                 # full 2,725-feature run (paid API, two passes)
    python run_comparison.py --limit 20      # smoke run on the first 20 features
    python run_comparison.py --no-hinted     # name-only pass only
    python run_comparison.py --out outputs/custom

Outputs (git-ignored): outputs/<timestamp>/{raw_name_only.json, raw_hinted.json,
comparison.csv, report.md}. Raw results are also reload-cached under outputs/raw/.
"""

from __future__ import annotations

import argparse
from datetime import datetime
from pathlib import Path

import compare as C
import io_and_normalize as io
import report as R
import run_pipeline as rp

DATA_DIR = Path(__file__).resolve().parent / "data"
MASTER_CSV = DATA_DIR / "per_metabolite_annotation.csv"


def build_hints_by_name(df) -> dict[str, dict[str, str]]:
    """Map each distinct matched_name -> hint dict (first non-empty wins for duplicate names)."""
    hints: dict[str, dict[str, str]] = {}
    for _, row in df.iterrows():
        name = str(row["matched_name"]).strip()
        if io.is_missing(name):
            continue
        h = io.build_hints(row)
        if name not in hints or (not hints[name] and h):
            hints[name] = h
    return hints


def main() -> None:
    ap = argparse.ArgumentParser(description="MS1 ↔ Biomapper concordance study")
    ap.add_argument("--limit", type=int, default=None, help="run only the first N features (smoke)")
    ap.add_argument("--no-hinted", action="store_true", help="skip the hinted pass")
    ap.add_argument("--out", type=str, default=None, help="override the output dir")
    ap.add_argument("--no-progress", action="store_true")
    ap.add_argument("--sub-batch", type=int, default=250,
                    help="names per sub-batch (pace upstream Kestrel; 0 disables)")
    ap.add_argument("--pause", type=float, default=10.0, help="seconds between sub-batches")
    ap.add_argument("--pass-pause", type=float, default=30.0,
                    help="seconds between the name-only and hinted passes")
    args = ap.parse_args()

    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    run_dir = Path(args.out) if args.out else (rp.OUTPUTS_ROOT / ts)
    progress = not args.no_progress

    print(f"[run_comparison] backend base_url = {rp.base_url()}  (confirm dev vs prod!)")
    print(f"[run_comparison] output dir = {run_dir}")

    df = io.load_features(MASTER_CSV)
    if args.limit:
        df = df.head(args.limit)
    names = io.distinct_names(df)
    print(f"[run_comparison] {len(df)} features, {len(names)} distinct names")

    sub_batch = args.sub_batch or None
    name_only = rp.run_pass(names, pass_name="name_only", run_dir=run_dir, progress=progress,
                            sub_batch=sub_batch, pause_s=args.pause)

    if not rp.looks_healthy(name_only):
        s = rp.summarize(name_only)
        raise SystemExit(
            f"[run_comparison] ABORT: name-only resolved {s['resolved']}/{s['total']} "
            f"(< {int(rp.MIN_PLAUSIBLE_RATE * 100)}%). The backend is degraded/throttled "
            f"(HTTP 200 with empty matches). Raw saved to {run_dir} for inspection; no "
            f"comparison/report written and the reload cache was not poisoned. Wait and re-run."
        )

    hinted = None
    if not args.no_hinted:
        import time
        if sub_batch and args.pass_pause:
            print(f"[run_comparison] pausing {args.pass_pause}s between passes")
            time.sleep(args.pass_pause)
        hints = build_hints_by_name(df)
        hinted = rp.run_pass(names, hints_by_name=hints, pass_name="hinted",
                             run_dir=run_dir, progress=progress,
                             sub_batch=sub_batch, pause_s=args.pause)

    bridge = C.RefMetBridge.from_data_dir(DATA_DIR)
    if not bridge.available:
        print("[run_comparison] RefMet master list not found in data/ — RefMet scored as "
              "'bridge_unavailable'. Drop refmet.csv (refmet_id,refmet_name) into data/ to enable.")

    comp = C.compare(df, name_only, hinted, bridge)
    comparison_path = run_dir / "comparison.csv"
    report_path = run_dir / "report.md"
    mapped_path = run_dir / "mapped_final.csv"
    C.write_comparison(comp, comparison_path)
    metrics = R.write_report(comp, report_path, meta={"timestamp": ts, "base_url": rp.base_url()})
    # UI-style export: original input columns + Biomapper mappings appended (_biomapper suffix).
    C.write_mapped_final(C.build_mapped_final(df, name_only), mapped_path)

    print("\n[run_comparison] DONE — artifacts:")
    print(f"  raw (name-only): {run_dir / 'raw_name_only.json'}")
    if hinted is not None:
        print(f"  raw (hinted)   : {run_dir / 'raw_hinted.json'}")
    print(f"  mapped final   : {mapped_path}")
    print(f"  comparison CSV : {comparison_path}")
    print(f"  report (md)    : {report_path}")
    print(f"  resolved (name-only): {metrics['lift']['name_only_resolved']}/{metrics['total']}")


if __name__ == "__main__":
    main()
