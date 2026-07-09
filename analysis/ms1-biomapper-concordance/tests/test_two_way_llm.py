"""Tests: two-way LLM fault-localization (mocked client) + payload minimization (security)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import two_way as TW  # noqa: E402
import two_way_llm as TL  # noqa: E402

_META = {
    "HMDB0000013": {"name": "D-Alanine", "formula": "C3H7NO2", "monoisotopic_mass": "89.0477",
                    "inchikey": "QNAYBMKLOCPYGJ-UWTATZPHSA-N"},
    "HMDB0000271": {"name": "Sarcosine", "formula": "C3H7NO2", "monoisotopic_mass": "89.0477",
                    "inchikey": "FSYKKLYZXJSNPZ-UHFFFAOYSA-N"},
}


def _row(extra=None):
    r = {"rep_spectral_id": "HMDB0000013", "rep_bmap_id": "HMDB0000271", "matched_name": "sarcosine",
         "structural_relation": "isomer", "mean_mz": "90.05", "neutral_mass": "89.05",
         "adduct_type": "[M+H]+", "spectral_cosine_max": "0.95", "two_way_state": TW.DISAGREE,
         # fields that MUST NOT leak:
         "spectral_hmdb": "HMDB0000013", "spectral_src": "M1:ms1_compound_name"}
    if extra:
        r.update(extra)
    return r


def test_payload_is_allowlisted():
    p = TL.build_payload(_row(), _META)
    assert set(p) <= TL.ALLOWED_PAYLOAD_KEYS
    flat = json.dumps(p)
    assert "M1:ms1_compound_name" not in flat              # provenance src excluded
    assert p["spectral_name"] == "D-Alanine" and p["bmap_name"] == "Sarcosine"
    assert p["matched_name"] == "sarcosine"                # matched_name IS included (not curated)
    assert p["structural_relation"] == "isomer"


def test_characterize_caches_and_injectable_client(tmp_path):
    calls = []

    def fake(payload):
        calls.append(payload)
        return {"fault_locus": "name_derivation", "recommended_id": "biomapper",
                "category": "isomer", "confidence": "high", "rationale": "matched_name is Sarcosine."}

    cache = tmp_path / "tl.json"
    out = TL.characterize([_row()], _META, cache, sleep_s=0, client=fake)
    assert len(out) == 1 and len(calls) == 1
    TL.characterize([_row()], _META, cache, sleep_s=0, client=fake)   # served from cache
    assert len(calls) == 1
    assert json.loads(cache.read_text())


def test_mismatch_mask_and_attach():
    delta = pd.DataFrame([
        {**_row(), "structural_relation": "isomer"},                                   # real conflict
        {**_row(), "rep_spectral_id": "X", "rep_bmap_id": "Y",
         "structural_relation": "same_structure", "two_way_state": TW.DISAGREE},        # id-synonym -> skip
        {**_row(), "rep_spectral_id": "Z", "rep_bmap_id": "W",
         "structural_relation": "unrelated", "two_way_state": TW.CONCORDANT},           # not a disagree -> skip
    ])
    mask = TL.mismatch_mask(delta)
    assert bool(mask.iloc[0]) and not bool(mask.iloc[1]) and not bool(mask.iloc[2])
    results = {TL._key(_row()): {"fault_locus": "name_derivation", "recommended_id": "biomapper",
                                 "category": "isomer", "confidence": "high", "rationale": "..."}}
    out = TL.attach_llm(delta, results)
    assert out.iloc[0]["llm_fault_locus"] == "name_derivation"
    assert out.iloc[0]["llm_recommended_id"] == "biomapper"
    assert out.iloc[1]["llm_fault_locus"] == "not_applicable"
