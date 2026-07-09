"""Helper for the Claude/Opus second-adjudicator loop over two-way conflict rows.

Usage:
    python claude_adjudicate.py next [N]      # print next N unadjudicated conflict payloads (JSON)
    python claude_adjudicate.py merge FILE    # merge a verdicts JSON ({_key: {...}}) into the cache
    python claude_adjudicate.py status        # how many conflicts adjudicated / remaining

Same conflict set and _key as two_way_llm, so Claude's verdicts line up row-for-row with gpt-4o-mini.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

import two_way as TW
import two_way_llm as TL

RUN = Path("outputs/20260610-102248")
META = Path("outputs/hmdb_metadata_cache.json")
CACHE = Path("outputs/two_way_claude_cache.json")
COMP = RUN / "comparison.csv"
XLSX = Path("data/All_Methods_Features.xlsx")


def _conflicts():
    comp = pd.read_csv(COMP, dtype=str)
    meta = json.loads(META.read_text())
    delta = TW.enrich_with_relation(TW.build_two_way(comp, XLSX), meta)
    mm = delta[TL.mismatch_mask(delta)]
    return [dict(r) for _, r in mm.iterrows()], meta


def _cache() -> dict:
    if CACHE.exists():
        try:
            return json.loads(CACHE.read_text())
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    rows, meta = _conflicts()
    cache = _cache()
    keys = [TL._key(r) for r in rows]
    done = {k for k in keys if k in cache}

    if cmd == "status":
        print(json.dumps({"total": len(rows), "adjudicated": len(done),
                          "remaining": len(rows) - len(done)}))
        return

    if cmd == "next":
        n = int(sys.argv[2]) if len(sys.argv) > 2 else 30
        out = []
        for r in rows:
            k = TL._key(r)
            if k in cache:
                continue
            p = TL.build_payload(r, meta)            # allowlisted public facts only
            out.append({"_key": k, "feature_id": r.get("feature_id"), **p})
            if len(out) >= n:
                break
        print(json.dumps(out, indent=1))
        return

    if cmd == "merge":
        verdicts = json.loads(Path(sys.argv[2]).read_text())
        valid_keys = set(keys)
        added = 0
        for k, v in verdicts.items():
            if k in valid_keys and k not in cache:
                cache[k] = v
                added += 1
        CACHE.write_text(json.dumps(cache, indent=0))
        print(json.dumps({"merged": added, "adjudicated_total": len(cache),
                          "remaining": len(rows) - len([k for k in keys if k in cache])}))
        return

    print("unknown command", cmd)


if __name__ == "__main__":
    main()
