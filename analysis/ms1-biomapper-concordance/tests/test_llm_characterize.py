"""Unit 6 tests: LLM characterization (mocked client) + payload minimization (security)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import llm_characterize as LC  # noqa: E402
import spectral_delta as SD  # noqa: E402

_META = {
    "HMDB0000237": {"name": "Propionic acid", "formula": "C3H6O2", "monoisotopic_mass": "74.0368",
                    "inchikey": "XBDQK-X-N", "class": None},
    "HMDBTRUTH": {"name": "Methylurea", "formula": "C2H6N2O", "monoisotopic_mass": "74.0480",
                  "inchikey": "AAAA-X-N", "class": None},
}


def _row(extra=None):
    r = {"rep_spectral_id": "HMDB0000237", "truth_id": "HMDBTRUTH", "structural_relation": "isobaric",
         "mean_mz": "75.04", "neutral_mass": "74.04", "adduct_type": "[M+H]+", "spectral_cosine_max": "0.9",
         # fields that MUST NOT leak into the payload:
         "matched_name": "methylurea", "emb_raw": "HMDB:HMDB00237-9 Propionic acid", "ref_hmdb": "HMDBTRUTH"}
    if extra:
        r.update(extra)
    return r


def test_payload_is_allowlisted_and_excludes_curated():
    p = LC.build_payload(_row(), _META)
    assert set(p) <= LC.ALLOWED_PAYLOAD_KEYS
    flat = json.dumps(p)
    assert "methylurea" not in flat            # curated matched_name excluded
    assert "HMDB:HMDB00237" not in flat        # raw spectral string excluded
    assert p["spectral_name"] == "Propionic acid" and p["truth_name"] == "Methylurea"
    assert p["structural_relation"] == "isobaric"


def test_characterize_caches_and_injectable_client(tmp_path):
    calls = []

    def fake_client(payload):
        calls.append(payload)
        return {"category": "isobaric", "adjudication": "truth", "confidence": "high",
                "rationale": "Near-equal masses; different formulas."}

    cache = tmp_path / "llm.json"
    out = LC.characterize([_row()], _META, cache, sleep_s=0, client=fake_client)
    assert len(out) == 1 and len(calls) == 1
    # second call served from cache, no new client call
    LC.characterize([_row()], _META, cache, sleep_s=0, client=fake_client)
    assert len(calls) == 1
    assert json.loads(cache.read_text())  # persisted


def test_malformed_client_result_cached_as_null(tmp_path):
    out = LC.characterize([_row()], _META, tmp_path / "c.json", sleep_s=0, client=lambda p: None)
    assert out == {}  # null excluded


def test_attach_llm_and_mismatch_mask():
    delta = pd.DataFrame([
        {**_row(), "three_way_state": SD.SPECTRAL_DISAGREES},
        {"rep_spectral_id": "X", "truth_id": "Y", "structural_relation": "same_structure",
         "three_way_state": SD.ALL_AGREE},
    ])
    mask = LC.mismatch_mask(delta)
    assert bool(mask.iloc[0]) and not bool(mask.iloc[1])  # only the real mismatch
    results = {LC._key(_row()): {"category": "isobaric", "adjudication": "truth",
                                 "confidence": "high", "rationale": "..."}}
    out = LC.attach_llm(delta, results)
    assert out.iloc[0]["llm_category"] == "isobaric"
    assert out.iloc[1]["llm_category"] == "not_applicable"
