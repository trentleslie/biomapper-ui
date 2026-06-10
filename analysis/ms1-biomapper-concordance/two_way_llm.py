"""Two-way LLM fault-localization for spectral <-> Biomapper HMDB disagreements (curated-free).

For each real conflict (disagree, with metadata on both sides and not same_structure), the LLM weighs
the SPECTRAL library id against BIOMAPPER's name-only id and localizes the likely fault in the chain:

    spectral HMDB id --(Metabolon name-derivation)--> matched_name --(Biomapper name->id)--> biomapper id

It returns which step most likely broke (``biomapper_mapping`` vs ``name_derivation``), which id it
recommends, and why. It is synonym/chemistry-aware where the deterministic string name-match is not.

PAYLOAD: an explicit allowlist of PUBLIC facts for the two competing ids (official HMDB
name/formula/mass/InChIKey), the matched_name under test (Metabolon's own analyte name, not a curated
reference), the deterministic structural_relation, and the measured numbers. No curated reference id
ever enters the payload. Calls are cached on disk and reuse llm_characterize's OpenAI client.
"""

from __future__ import annotations

import hashlib
import json
import time
from functools import partial
from pathlib import Path
from typing import Callable

from llm_characterize import openai_chat

FAULT_TAXONOMY = ["biomapper_mapping", "name_derivation", "cannot_tell"]
CATEGORY_TAXONOMY = ["isomer", "isobaric", "in_source_fragment", "adduct", "co_elution",
                     "name_synonym", "library_mislabel", "unrelated", "other"]

# The ONLY fields permitted into the prompt.
ALLOWED_PAYLOAD_KEYS = {
    "matched_name",
    "spectral_name", "spectral_formula", "spectral_mono_mass", "spectral_inchikey",
    "bmap_name", "bmap_formula", "bmap_mono_mass", "bmap_inchikey",
    "structural_relation", "mean_mz", "neutral_mass", "adduct_type", "spectral_cosine_max",
}

_SYSTEM = (
    "You are a mass-spectrometry metabolite-identification expert. One LC-MS feature has TWO competing "
    "HMDB identities: a SPECTRAL library hit (from the instrument's spectral match) and a BIOMAPPER hit "
    "(obtained by mapping the feature's assigned name, 'matched_name', through a name->id resolver). "
    "The processing chain is: spectral_id -> matched_name (a name-derivation step) -> biomapper_id. "
    "Given the public chemical facts for both ids, the matched_name, the deterministic structural "
    "relation, and the measured values, decide WHERE the discrepancy most likely originates:\n"
    "- 'biomapper_mapping': matched_name describes the SPECTRAL compound, but Biomapper resolved it to a "
    "different id (the name->id step drifted).\n"
    "- 'name_derivation': the SPECTRAL library id does not correspond to matched_name (the spectral "
    "id->name step is inconsistent); Biomapper may have mapped matched_name faithfully.\n"
    "- 'cannot_tell': facts are insufficient.\n"
    "Judge name/compound equivalence semantically (synonyms, salts, stereochemistry, acid/anion forms), "
    "not by string equality. Ground every statement in the given facts. "
    f"Return JSON: {{\"fault_locus\": one of {FAULT_TAXONOMY}, "
    "\"recommended_id\": one of [\"spectral\",\"biomapper\",\"cannot_tell\"], "
    f"\"category\": one of {CATEGORY_TAXONOMY}, "
    "\"confidence\": one of [\"high\",\"medium\",\"low\"], \"rationale\": \"1-2 sentences\"}."
)


# Default client: reuse llm_characterize's OpenAI caller but with THIS module's system prompt.
_two_way_client = partial(openai_chat, system=_SYSTEM)


def build_payload(row: dict, meta: dict[str, dict]) -> dict:
    def f(hid, field):
        d = meta.get(str(hid)) or {}
        return d.get(field)
    spec, bmap = row.get("rep_spectral_id"), row.get("rep_bmap_id")
    payload = {
        "matched_name": row.get("matched_name"),
        "spectral_name": f(spec, "name"), "spectral_formula": f(spec, "formula"),
        "spectral_mono_mass": f(spec, "monoisotopic_mass"), "spectral_inchikey": f(spec, "inchikey"),
        "bmap_name": f(bmap, "name"), "bmap_formula": f(bmap, "formula"),
        "bmap_mono_mass": f(bmap, "monoisotopic_mass"), "bmap_inchikey": f(bmap, "inchikey"),
        "structural_relation": row.get("structural_relation"),
        "mean_mz": row.get("mean_mz"), "neutral_mass": row.get("neutral_mass"),
        "adduct_type": row.get("adduct_type"), "spectral_cosine_max": row.get("spectral_cosine_max"),
    }
    assert set(payload) <= ALLOWED_PAYLOAD_KEYS, "payload contains a non-allowlisted key"
    return payload


def _key(row: dict) -> str:
    return hashlib.md5(
        f"2way|{row.get('rep_spectral_id')}|{row.get('rep_bmap_id')}".encode()).hexdigest()[:12]


def mismatch_mask(delta):
    """Real conflicts worth LLM fault-localization: a disagreement with metadata on both sides that is
    not a same-structure (id-synonym) case."""
    import two_way as tw
    return (delta["two_way_state"] == tw.DISAGREE) & (
        ~delta["structural_relation"].isin(["same_structure", "undetermined_no_metadata"]))


def attach_llm(delta, results: dict[str, dict]):
    """Add llm_fault_locus / llm_recommended_id / llm_category / llm_confidence / llm_rationale."""
    out = delta.copy()
    fl, rid, cat, conf, rat = [], [], [], [], []
    for _, row in delta.iterrows():
        r = results.get(_key(dict(row)))
        fl.append(r.get("fault_locus") if r else "not_applicable")
        rid.append(r.get("recommended_id") if r else "not_applicable")
        cat.append(r.get("category") if r else "not_applicable")
        conf.append(r.get("confidence") if r else "not_applicable")
        rat.append(r.get("rationale") if r else "not_applicable")
    out["llm_fault_locus"], out["llm_recommended_id"] = fl, rid
    out["llm_category"], out["llm_confidence"], out["llm_rationale"] = cat, conf, rat
    return out


def characterize(rows: list[dict], meta: dict[str, dict], cache_path: str | Path, *,
                 sleep_s: float = 0.3, client: Callable[[dict], dict | None] = _two_way_client) -> dict[str, dict]:
    """Characterize each conflict row; cache by (spectral_id, biomapper_id). ``client`` injectable."""
    cache_path = Path(cache_path)
    cache: dict[str, dict | None] = {}
    if cache_path.exists():
        try:
            cache = json.loads(cache_path.read_text())
        except (json.JSONDecodeError, OSError):
            cache = {}
    def flush():
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(cache, indent=0))

    dirty = False
    since_flush = 0
    for row in rows:
        k = _key(row)
        if k in cache:
            continue
        if dirty and sleep_s:
            time.sleep(sleep_s)
        cache[k] = client(build_payload(row, meta))
        dirty = True
        since_flush += 1
        if since_flush >= 25:   # persist incrementally so a timeout/crash never discards paid calls
            flush()
            since_flush = 0
    if dirty:
        flush()
    return {k: v for k, v in cache.items() if v}
