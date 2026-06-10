"""Resolve HMDB IDs -> official metadata via Metabolomics Workbench (+ PubChem fallback).

By-ID metadata for the spectral-delta characterization, mirroring refmet_api.py:
- Tier 1: MW ``compound/hmdb_id/<id>/all/`` → name, formula, exactmass, inchi_key, pubchem_cid,
  chebi_id, kegg_id, smiles (verified field names). MW has NO chemical class field.
- Tier 2 (best-effort): PubChem PUG by a compound *name hint* (used only when MW misses the ID and
  a name is available) → MolecularFormula, MonoisotopicMass, InChIKey, Title, CID.

Results (including misses, cached as ``None``) are cached on disk so reruns are free and an offline
cache-replay path works. ``mw_fetch``/``pubchem_fetch`` are injectable for tests. Sending HMDB IDs to
MW/PubChem is a dataset-derived outbound call (data-sharing point) — gate live fetching upstream.

The HMDB profile link is constructed locally; chemical class is best-effort (null here — would need a
HMDB→name→RefMet hop, deferred).
"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable

MW_COMPOUND_URL = "https://www.metabolomicsworkbench.org/rest/compound/hmdb_id/{}/all/"
PUBCHEM_NAME_URL = (
    "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/{}/property/"
    "MolecularFormula,MonoisotopicMass,InChIKey,Title/JSON"
)
HMDB_LINK = "https://hmdb.ca/metabolites/{}"

# Output metadata schema (keys always present; values may be None).
FIELDS = ("name", "formula", "monoisotopic_mass", "inchikey", "pubchem_cid",
          "chebi_id", "kegg_id", "smiles", "class", "link", "source", "retrieved")


def _http_json(url: str, timeout: float = 30.0, retries: int = 2, backoff: float = 1.5) -> dict | None:
    """GET + parse JSON. Retries on network/HTTP error (transient throttling) with backoff.

    Returns the parsed body, or None only after exhausting retries (or a clean non-JSON body).
    A genuine 'no record' is a JSON body without the expected keys (handled by the caller), not None.
    """
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as resp:
                return json.loads(resp.read().decode())
        except Exception:
            if attempt < retries:
                time.sleep(backoff * (attempt + 1))
                continue
            return None
    return None


def mw_fetch(hmdb_id: str) -> dict | None:
    """Tier 1: MW compound by HMDB ID. Returns the normalized metadata dict or None on miss."""
    d = _http_json(MW_COMPOUND_URL.format(hmdb_id))
    if not isinstance(d, dict) or not d.get("hmdb_id"):
        return None
    return {
        "name": d.get("name"),
        "formula": d.get("formula"),
        "monoisotopic_mass": d.get("exactmass"),
        "inchikey": d.get("inchi_key"),
        "pubchem_cid": d.get("pubchem_cid"),
        "chebi_id": d.get("chebi_id"),
        "kegg_id": d.get("kegg_id"),
        "smiles": d.get("smiles"),
        "class": None,  # MW compound endpoint has no class; best-effort, deferred
        "source": "mw",
    }


def pubchem_fetch(name: str) -> dict | None:
    """Tier 2: PubChem PUG by compound name. Returns partial metadata or None."""
    d = _http_json(PUBCHEM_NAME_URL.format(urllib.parse.quote(str(name))))
    try:
        p = d["PropertyTable"]["Properties"][0]  # type: ignore[index]
    except (TypeError, KeyError, IndexError):
        return None
    return {
        "name": p.get("Title"),
        "formula": p.get("MolecularFormula"),
        "monoisotopic_mass": (str(p["MonoisotopicMass"]) if p.get("MonoisotopicMass") is not None else None),
        "inchikey": p.get("InChIKey"),
        "pubchem_cid": (str(p["CID"]) if p.get("CID") is not None else None),
        "chebi_id": None, "kegg_id": None, "smiles": None,
        "class": None,
        "source": "pubchem",
    }


def resolve_hmdb_metadata(
    ids,
    cache_path: str | Path,
    *,
    name_hints: dict[str, str] | None = None,
    retrieved: str = "",
    sleep_s: float = 0.0,
    mw: Callable[[str], dict | None] = mw_fetch,
    pubchem: Callable[[str], dict | None] = pubchem_fetch,
) -> dict[str, dict]:
    """Map ``{hmdb_id -> metadata dict}`` (FIELDS keys), MW then PubChem-by-name, disk-cached.

    ``name_hints`` supplies a compound name per HMDB ID for the PubChem fallback (e.g. the spectral
    name) — used only when MW misses. Misses are cached as ``None``. ``retrieved`` stamps provenance.
    ``mw``/``pubchem`` are injectable for tests.
    """
    cache_path = Path(cache_path)
    cache: dict[str, dict | None] = {}
    if cache_path.exists():
        try:
            cache = json.loads(cache_path.read_text())
        except (json.JSONDecodeError, OSError):
            cache = {}

    name_hints = name_hints or {}
    dirty = False
    for hid in sorted({i for i in ids if i}):
        if hid in cache:
            continue
        if dirty and sleep_s:
            time.sleep(sleep_s)  # pace live calls to avoid MW/PubChem throttling
        meta = mw(hid)
        if meta is None and name_hints.get(hid):
            meta = pubchem(name_hints[hid])
        if meta is not None:
            meta = {**{k: None for k in FIELDS}, **meta,
                    "link": HMDB_LINK.format(hid), "retrieved": retrieved}
        cache[hid] = meta
        dirty = True

    if dirty:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(cache, indent=0))

    return {hid: m for hid, m in cache.items() if m is not None}
