"""Input-side resolver hints derived from the analyte files (NOT the ground truth).

Hints must come from what was provided alongside the names to map — never from the curated
reference annotations (that would be circular). The only identifier-bearing material on the
input side is in All_Methods_Features.xlsx:

- HMDB IDs embedded in ``ms1_compound_name`` / ``ms2_compound_name`` strings
  (e.g. ``"HMDB:HMDB04296-2379 Acrylamide"`` -> HMDB0004296)
- CAS numbers in ``ms2_cas_id`` (e.g. ``79-06-1``)

Both are honored by the BioMapper2 API as hints (verified empirically). A name can appear on
several feature rows / methods with differing candidates; we keep the **modal** value per
namespace for determinism.

CAS is NOT one of the scored namespaces (HMDB/CHEBI/KEGG.COMPOUND/LIPIDMAPS/PUBCHEM.COMPOUND),
so a CAS hint never makes a scored namespace circular. HMDB *is* scored, so an HMDB hint makes
only the HMDB namespace circular for that feature (excluded from concordance downstream).
"""

from __future__ import annotations

import re
from collections import Counter
from pathlib import Path

import pandas as pd

import io_and_normalize as io

_HMDB_RE = re.compile(r"HMDB\d+")
_CAS_RE = re.compile(r"^\d{2,7}-\d{2}-\d$")  # CAS registry format, e.g. 79-06-1
NAME_COLUMNS = ("ms1_compound_name", "ms2_compound_name")
CAS_COLUMN = "ms2_cas_id"

# Hint namespaces this module can supply, in priority order. HMDB is a scored namespace
# (circularity-relevant); CAS is not.
HINT_NAMESPACES = ("HMDB", "CAS")


def _modal(counter: Counter) -> str:
    """Most-frequent value, tie-broken by sorted order for determinism."""
    top = max(counter.values())
    return sorted(k for k, v in counter.items() if v == top)[0]


def build_input_hints(xlsx_path: str | Path) -> dict[str, dict[str, str]]:
    """Map each distinct ``matched_name`` -> ``{namespace: id}`` from input-side evidence.

    Returns only names that have at least one hint. Values are single modal picks.
    """
    xls = pd.ExcelFile(xlsx_path)
    hmdb: dict[str, Counter] = {}
    cas: dict[str, Counter] = {}
    for sheet in xls.sheet_names:
        s = pd.DataFrame(xls.parse(sheet, dtype=str, keep_default_na=False))
        if "matched_name" not in s.columns:
            continue
        for _, row in s.iterrows():
            name = str(row.get("matched_name", "")).strip()
            if io.is_missing(name):
                continue
            for col in NAME_COLUMNS:
                for raw in _HMDB_RE.findall(str(row.get(col, ""))):
                    nid = io.normalize_id("HMDB", raw)
                    if nid:
                        hmdb.setdefault(name, Counter())[nid] += 1
            cas_val = str(row.get(CAS_COLUMN, "")).strip()
            if not io.is_missing(cas_val) and _CAS_RE.match(cas_val):
                cas.setdefault(name, Counter())[cas_val] += 1

    hints: dict[str, dict[str, str]] = {}
    for name in set(hmdb) | set(cas):
        h: dict[str, str] = {}
        if name in hmdb:
            h["HMDB"] = _modal(hmdb[name])
        if name in cas:
            h["CAS"] = _modal(cas[name])
        if h:
            hints[name] = h
    return hints
