"""Helper for the Claude/Opus group-reasoning loop over multi-HMDB matched_name sets.

Some matched_names carry MORE THAN ONE distinct embedded spectral HMDB id (across features / within
a cell). This treats each such name as a GROUP and asks: do any of the group's spectral ids match
Biomapper's id, and what are these competing ids collectively (isomers? isobars? contamination?
unrelated noise?) given their HMDB metadata.

Usage:
    python group_reason.py status
    python group_reason.py next [N]     # print next N un-reasoned multi-HMDB groups (JSON)
    python group_reason.py merge FILE   # merge {matched_name: {...}} summaries into the cache
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

import two_way as TW

RUN = Path("outputs/20260610-102248")
META = Path("outputs/hmdb_metadata_cache.json")
CACHE = Path("outputs/group_reason_cache.json")
COMP = RUN / "comparison.csv"
XLSX = Path("data/All_Methods_Features.xlsx")


def _ids(c):
    return {x for x in str(c).split(";") if x.strip()} if isinstance(c, str) and c else set()


def _groups():
    comp = pd.read_csv(COMP, dtype=str)
    meta = json.loads(META.read_text())
    delta = TW.build_two_way(comp, XLSX)
    g = {}
    for _, r in delta.iterrows():
        nm = r["matched_name"]
        d = g.setdefault(nm, {"spectral": set(), "bmap": set(), "features": 0, "cosines": []})
        d["spectral"] |= _ids(r["spectral_hmdb"])
        d["bmap"] |= _ids(r["bmap_hmdb"])
        d["features"] += 1
        if r.get("spectral_cosine_max") not in (None, ""):
            try:
                d["cosines"].append(round(float(r["spectral_cosine_max"]), 3))
            except (TypeError, ValueError):
                pass
    multi = {nm: d for nm, d in g.items() if len(d["spectral"]) > 1}
    return multi, meta


def _facts(hid, meta):
    m = meta.get(str(hid)) or {}
    return {"hmdb": hid, "name": m.get("name"), "formula": m.get("formula"),
            "mono_mass": m.get("monoisotopic_mass"), "inchikey": m.get("inchikey")}


def _cache():
    if CACHE.exists():
        try:
            return json.loads(CACHE.read_text())
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    multi, meta = _groups()
    cache = _cache()

    if cmd == "status":
        print(json.dumps({"groups": len(multi), "reasoned": len([n for n in multi if n in cache]),
                          "remaining": len([n for n in multi if n not in cache])}))
        return

    if cmd == "next":
        n = int(sys.argv[2]) if len(sys.argv) > 2 else 30
        out = []
        for nm in sorted(multi):
            if nm in cache:
                continue
            d = multi[nm]
            spectral = sorted(d["spectral"])
            bmap = sorted(d["bmap"])
            out.append({
                "matched_name": nm,
                "n_features": d["features"],
                "spectral_ids": [_facts(h, meta) for h in spectral],
                "biomapper_ids": [_facts(h, meta) for h in bmap],
                "any_spectral_matches_biomapper": bool(d["spectral"] & d["bmap"]),
                "matching_ids": sorted(d["spectral"] & d["bmap"]),
            })
            if len(out) >= n:
                break
        print(json.dumps(out, indent=1))
        return

    if cmd == "merge":
        summaries = json.loads(Path(sys.argv[2]).read_text())
        valid = set(multi)
        added = 0
        for nm, v in summaries.items():
            if nm in valid and nm not in cache:
                cache[nm] = v
                added += 1
        CACHE.write_text(json.dumps(cache, indent=0))
        print(json.dumps({"merged": added, "reasoned_total": len(cache),
                          "remaining": len([n for n in multi if n not in cache])}))
        return

    print("unknown command", cmd)


if __name__ == "__main__":
    main()
