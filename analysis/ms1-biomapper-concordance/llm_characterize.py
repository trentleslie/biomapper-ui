"""Unit 6 (Phase 2, gated): LLM cause narration for spectral-ID mismatches.

For real mismatches (non-`same_structure`), the LLM names the likely *cause* and adjudicates which ID
is the true identity — but only as a layer on top of the deterministic structural relation (Unit 3),
which already settles isomer/isobar/same. Output is advisory.

PAYLOAD MINIMIZATION (security): the prompt is built from an explicit allowlist of **public** facts
(HMDB names/formula/mass/InChIKey/class for the two competing IDs), the deterministic relation, and
the feature's measured numbers (mean_mz / neutral_mass / adduct / cosine). It NEVER contains the
curated `matched_name`, the raw spectral string, or the curated `ref_hmdb`. Calls are cached on disk
(offline-replayable) and gated behind --allow-llm upstream (data-sharing).

Uses the OpenAI chat completions REST API directly (urllib) — no SDK dependency.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
import urllib.request
from pathlib import Path
from typing import Callable

_REPO_ROOT = Path(__file__).resolve().parents[2]
OPENAI_URL = "https://api.openai.com/v1/chat/completions"
DEFAULT_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")

TAXONOMY = ["isomer", "isobaric", "in_source_fragment", "adduct", "co_elution",
            "name_synonym", "library_mislabel", "unrelated", "other"]

# The ONLY fields permitted into the prompt. Anything not here cannot leak.
ALLOWED_PAYLOAD_KEYS = {
    "spectral_name", "spectral_formula", "spectral_mono_mass", "spectral_inchikey", "spectral_class",
    "truth_name", "truth_formula", "truth_mono_mass", "truth_inchikey", "truth_class",
    "structural_relation", "mean_mz", "neutral_mass", "adduct_type", "spectral_cosine_max",
}

_SYSTEM = (
    "You are a mass-spectrometry metabolite-identification expert. You are given the public chemical "
    "facts for two candidate identities of one LC-MS feature: a SPECTRAL library hit and a NAME-BASED "
    "(curated) identity, plus a deterministic structural relation and the feature's measured values. "
    "Explain the most likely CAUSE of the discrepancy and which identity is more likely correct. "
    "Ground every statement in the given facts; if the facts are insufficient, say so. "
    f"Return JSON: {{\"category\": one of {TAXONOMY}, "
    "\"adjudication\": one of [\"spectral\",\"truth\",\"insufficient_evidence\"], "
    "\"confidence\": one of [\"high\",\"medium\",\"low\"], \"rationale\": \"1-2 sentences\"}."
)


def load_openai_key() -> str:
    if not os.environ.get("OPENAI_API_KEY"):
        from dotenv import load_dotenv
        load_dotenv(_REPO_ROOT / ".env")
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise RuntimeError("OPENAI_API_KEY not set / not in repo .env")
    return key


def build_payload(row: dict, meta: dict[str, dict]) -> dict:
    """Allowlisted public-facts payload for one mismatch row. Never includes curated identity/raw."""
    def f(hid, field):
        d = meta.get(str(hid)) or {}
        return d.get(field)
    spec, truth = row.get("rep_spectral_id"), row.get("truth_id")
    payload = {
        "spectral_name": f(spec, "name"), "spectral_formula": f(spec, "formula"),
        "spectral_mono_mass": f(spec, "monoisotopic_mass"), "spectral_inchikey": f(spec, "inchikey"),
        "spectral_class": f(spec, "class"),
        "truth_name": f(truth, "name"), "truth_formula": f(truth, "formula"),
        "truth_mono_mass": f(truth, "monoisotopic_mass"), "truth_inchikey": f(truth, "inchikey"),
        "truth_class": f(truth, "class"),
        "structural_relation": row.get("structural_relation"),
        "mean_mz": row.get("mean_mz"), "neutral_mass": row.get("neutral_mass"),
        "adduct_type": row.get("adduct_type"), "spectral_cosine_max": row.get("spectral_cosine_max"),
    }
    assert set(payload) <= ALLOWED_PAYLOAD_KEYS, "payload contains a non-allowlisted key"
    return payload


def openai_chat(payload: dict, *, model: str = DEFAULT_MODEL, timeout: float = 60.0,
                retries: int = 2, backoff: float = 2.0) -> dict | None:
    """Call OpenAI chat completions (JSON mode) with the allowlisted facts. Returns parsed dict or None."""
    body = json.dumps({
        "model": model,
        "response_format": {"type": "json_object"},
        "temperature": 0,
        "messages": [{"role": "system", "content": _SYSTEM},
                     {"role": "user", "content": json.dumps(payload)}],
    }).encode()
    req = urllib.request.Request(
        OPENAI_URL, data=body, method="POST",
        headers={"Authorization": f"Bearer {load_openai_key()}", "Content-Type": "application/json"})
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read().decode())
            content = data["choices"][0]["message"]["content"]
            out = json.loads(content)
            return out if isinstance(out, dict) else None
        except Exception:
            if attempt < retries:
                time.sleep(backoff * (attempt + 1))
                continue
            return None
    return None


def _key(row: dict) -> str:
    return hashlib.md5(f"{row.get('rep_spectral_id')}|{row.get('truth_id')}".encode()).hexdigest()[:12]


def mismatch_mask(delta):
    """Rows worth LLM narration: a real mismatch (not all-agree/no-arbiter) and not same_structure."""
    import spectral_delta as sd
    states = {sd.SPECTRAL_DISAGREES, sd.BIOMAPPER_DISAGREES, sd.ALL_DIFFER, sd.CURATION_OUTLIER}
    return delta["three_way_state"].isin(states) & (delta["structural_relation"] != "same_structure")


def attach_llm(delta, results: dict[str, dict]):
    """Add llm_category/adjudication/confidence/rationale columns from cached results (by row key).

    Non-characterized rows get 'not_applicable'."""
    out = delta.copy()
    cats, adjs, confs, rats = [], [], [], []
    for _, row in delta.iterrows():
        r = results.get(_key(dict(row)))
        cats.append(r.get("category") if r else "not_applicable")
        adjs.append(r.get("adjudication") if r else "not_applicable")
        confs.append(r.get("confidence") if r else "not_applicable")
        rats.append(r.get("rationale") if r else "not_applicable")
    out["llm_category"], out["llm_adjudication"] = cats, adjs
    out["llm_confidence"], out["llm_rationale"] = confs, rats
    return out


def characterize(rows: list[dict], meta: dict[str, dict], cache_path: str | Path, *,
                 sleep_s: float = 0.3, client: Callable[[dict], dict | None] = openai_chat) -> dict[str, dict]:
    """Characterize each mismatch row; cache by (spectral_id, truth_id). ``client`` injectable for tests."""
    cache_path = Path(cache_path)
    cache: dict[str, dict | None] = {}
    if cache_path.exists():
        try:
            cache = json.loads(cache_path.read_text())
        except (json.JSONDecodeError, OSError):
            cache = {}
    dirty = False
    for row in rows:
        k = _key(row)
        if k in cache:
            continue
        if dirty and sleep_s:
            time.sleep(sleep_s)
        cache[k] = client(build_payload(row, meta))
        dirty = True
    if dirty:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(cache, indent=0))
    return {k: v for k, v in cache.items() if v}
