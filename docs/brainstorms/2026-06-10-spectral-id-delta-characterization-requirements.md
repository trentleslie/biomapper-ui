# Spectral-ID Delta Characterization (HMDB mismatch audit)

Created: 2026-06-10
Revised: 2026-06-10 (after document-review)
Status: requirements
Audience: Metabolon (collaborator) + internal analysts

## Problem Frame

The MS1 ↔ Biomapper concordance study surfaced a sharp delta: of the 416 features where both
the **embedded spectral HMDB** (parsed from `ms1/ms2_compound_name`) and **Biomapper name-only**
return an HMDB, **47% (197) disagree**, and in those disagreements the spectral ID matches the
**curated reference** only ~6/176 of the time vs Biomapper name-only at 164/176. The spectral
library hits are frequently mis-identifications (isobars/isomers — e.g. 1-methylnicotinamide's
MS1 hit was *D-Limonene*, at ms1_cosine_score ~0.90–0.97). Metabolon (post-meeting) wants to
**characterize this delta**: which features match vs not, what each competing HMDB ID *actually
is* (official metadata), and *why* each mismatch happens — an auditable error profile of the
spectral annotation pipeline.

Two caveats the review surfaced that shape the work:
- The current **embedded HMDB is modal-collapsed per name** (`input_hints._modal` keeps one value;
  103 names carry >1 distinct embedded HMDB across rows/methods). The headline 197/47% is computed
  over that reduced artifact, not Metabolon's per-feature spectral calls. This characterization must
  operate at the **feature/spectrum grain** (preserve every embedded ID + its frequency/cosine).
- The **curated reference is a baseline, not absolute truth** — it has its own error rate, and there
  are two curation signals (`per_metabolite_annotation.csv` vs the xlsx's `curation_chemical_id`/
  `curation_score`). Percentages are "relative to the curated reference," not "spectral errors."

Builds on: `analysis/ms1-biomapper-concordance/` (harness, cached mapping results,
`outputs/<run>/embedded_vs_nameonly_mismatches.csv`).

## Goals

- Classify every feature carrying an embedded HMDB into a **three-way agreement state** (spectral
  vs Biomapper name-only vs curated reference), with curation as a **fallible baseline** and an
  explicit state for "no curated arbiter."
- Attach **official metadata** to each competing HMDB ID (via MW/PubChem by HMDB ID).
- **Compute the structural relation deterministically** (same-structure / isomer / isobar) from
  InChIKey + formula + monoisotopic mass; use the LLM to **narrate the likely cause/mechanism** and
  to adjudicate **only** where the facts don't settle it (allowing "insufficient evidence").
- Aggregate into a **spectral-library error profile**, **stratified by spectral confidence**
  (ms1_cosine/ms2_score) — high-confidence-but-wrong is the actionable signal.
- Ship as **both** a reproducible harness step and a polished standalone Metabolon export.

## Users & Value

- **Metabolon** — QC of their MS1/MS2 spectral annotation library: where it diverges from curated
  identity, by confidence band, and the systematic reasons.
- **Internal analysts** — a defensible, provenance-tracked artifact backing the collaboration.

## Requirements

- **R1. Three-way match classification.** For every feature with an embedded HMDB, classify
  agreement across {spectral, Biomapper name-only, curated reference}: states include all-agree,
  spectral-disagrees, biomapper-disagrees, all-differ, **no-curated-arbiter** (21/197 rows have no
  reference HMDB), and **spectral-disagrees-but-may-be-correct** (curation treated as fallible). For
  multi-valued sides, reuse `compare.classify`'s set-overlap semantics (exact/partial/disagree) —
  do not invent pairing. Reconcile which curation is the arbiter (per_metabolite vs xlsx curation).
- **R2. Official metadata per competing HMDB ID.** Source by HMDB ID, two-tier and cached on disk
  (mirroring `refmet_api.py`): **tier 1** MW `compound/hmdb_id/<id>/all/` → name, formula,
  monoisotopic mass, InChIKey, pubchem_cid (verified; ~13% of IDs miss); **tier 2** PubChem PUG
  fallback for misses. Profile link is constructed (`https://hmdb.ca/metabolites/<id>`). **Chemical
  class** is **best-effort** (MW HMDB endpoint omits it; requires a HMDB→name→RefMet hop) — may be
  null. Record per entry which tier/source supplied each value and the **retrieval date** (provenance).
- **R3. Per-mismatch characterization (deterministic verdict + LLM narration).**
  - (a) **Deterministic structural relation** computed from InChIKey (same → same structure;
    differ + same formula → isomer; different formula + ~equal monoisotopic mass → isobar). No LLM
    needed for this verdict when InChIKeys are present.
  - (b) **LLM** produces the cause **category** (isomer / isobaric / in-source fragment / adduct /
    name-synonym / unrelated / **other**) and a **1–2 sentence rationale**; it adjudicates "which ID
    is most likely correct" **only where the deterministic verdict + measured evidence don't settle
    it**, and may output **"insufficient evidence."** For undetermined rows, feed the feature's
    measured evidence (`neutral_mass`, `adduct_type`, `ms1_cosine_score`).
  - (c) **Payload minimization:** the LLM prompt contains **only public HMDB-derived facts + the
    competing HMDB IDs + measured mz/adduct/score** — never `matched_name`, `emb_raw`, or the
    curated `ref_hmdb`. Output is labeled **LLM-generated/advisory** with a confidence signal.
- **R4. Aggregate error profile, confidence-stratified.** Cause-category distribution and
  spectral-vs-curation correctness rate, **stratified by spectral confidence band**
  (e.g. high vs low cosine). State the **coverage denominator** explicitly and frame results as the
  "**embedded-HMDB, name-parseable slice**," not "the library's failure modes."
- **R5. Two deliverables.** (a) **Reproducible harness step** → enriched CSV + report section +
  notebook cell, regenerating each run from cached results; the upstream mismatch-CSV generator
  (currently ad-hoc) must be **committed as a harness step** (it produces the
  `emb_sheet/emb_col/emb_raw/...` provenance). (b) **Standalone Metabolon export** — a **pure
  rendering layer over (a)'s outputs** (summary up top + per-mismatch table), no extra mapping/LLM
  calls. Export inherits the README confidentiality handling (share only via the original channel).
- **R6. Provenance per row, all three sides.** Embedded ID → source file/sheet/column + raw cell +
  cosine; Biomapper → join back to `raw_name_only.json` (chosen IDs, confidence tier); reference →
  `per_metabolite_annotation.csv`; metadata → tier/source + retrieval date.
- **R7. Validation gate.** Spot-check a **stratified sample (N≈10–15, across cause categories and
  confidence bands)** against manual review before the export is shared; the aggregate profile is
  labeled **provisional/unvalidated** until the spot-check passes. (Promoted to a success gate, not
  an open question.)

## Scope Boundaries / Non-Goals

- **HMDB only.** Embedded IDs are HMDB (from names) + CAS; CAS characterization out of scope for v1.
- **Embedded-HMDB, name-parseable features only.** Broader Biomapper-vs-curation disagreements with
  no embedded ID are out of scope. Report the coverage denominator so the slice is explicit.
- **Deep enrichment on non-all-agree only.** All-agree features get counts, no metadata/LLM enrichment.
- **No re-mapping.** Reuse cached `raw_name_only.json` / comparison results.
- **No bulk HMDB download** — metadata comes via MW/PubChem by ID (R2).

## Key Decisions (made during brainstorm + review)

- Match basis: **three-way** (spectral / Biomapper / curated), curation as a **fallible baseline**.
- LLM role: **narrate cause + adjudicate only the undetermined**; deterministic InChIKey/formula/mass
  settles structure first (refines the earlier "LLM adjudicates" choice).
- Metadata: by HMDB ID via **MW `compound/hmdb_id` + PubChem fallback**; class best-effort; no bulk download.
- Embedded IDs handled at **feature/spectrum grain** (no modal collapse); profile **confidence-stratified**.
- Deliverable: **both** reproducible harness step + standalone export (export = rendering layer).
- LLM payload: **public facts + IDs only** (no Metabolon names/raw/curated IDs).

## Open Questions (resolve before/at planning)

- **BLOCKING — data-sharing/legal:** Does the Metabolon agreement permit sending any
  dataset-derived value (even public HMDB IDs/facts) to a third-party LLM API, and on a
  zero-retention/no-training plan? Confirm with Metabolon before the LLM step is built.
- **Which curation is the arbiter** — `per_metabolite_annotation.csv` vs xlsx `curation_chemical_id`/
  `curation_score`; do they agree on the mismatch set?
- **LLM provider:** only `OPENAI_API_KEY` is present in the env (no Anthropic SDK/key installed);
  decide provider accordingly and add the SDK + `.env` key (no shell-history exposure).
- **Chemical class:** keep as best-effort (HMDB→name→RefMet hop) or drop from the export?
- **Spot-check threshold:** the agreement bar that gates "validated" (R7).

## Success Criteria

- A Metabolon-shareable report + CSV where every embedded-HMDB feature has a match status (incl. the
  no-arbiter and may-be-correct states), and every mismatch shows competing HMDB IDs with metadata,
  a **deterministic** structural relation, and an LLM cause/narration (advisory).
- A **confidence-stratified** error profile with an explicit coverage denominator, framed as the
  embedded-HMDB-parseable slice.
- Reproducible from cached results (committed generator, no new mapping calls); provenance intact.
- **Spot-check passed** (R7) before the export is treated as validated; otherwise labeled provisional.

## Sources & References

- Harness + data: `analysis/ms1-biomapper-concordance/` (`compare.py`, `report.py`,
  `input_hints.py`, `refmet_api.py`, `outputs/<run>/comparison.csv`,
  `outputs/<run>/embedded_vs_nameonly_mismatches.csv`).
- Verified during review: MW `compound/hmdb_id/<id>/all/` returns name/formula/exactmass/inchi_key/
  pubchem_cid (299/344 mismatch IDs; class absent); PubChem PUG resolves MW misses (e.g. L-Fucose).
- Prior finding: report "Hinted-pass cross-namespace agreement" + the 197-mismatch analysis
  (spectral matches curation ~6/176; name-only 164/176).
