---
title: "feat: Spectral-ID delta characterization (HMDB mismatch audit)"
type: feat
status: active
date: 2026-06-10
deepened: 2026-06-10
origin: docs/brainstorms/2026-06-10-spectral-id-delta-characterization-requirements.md
---

# feat: Spectral-ID Delta Characterization (HMDB mismatch audit)

## Overview

Characterize, for the Metabolon collaboration, where the **embedded spectral HMDB** IDs (parsed
from `ms1/ms2_compound_name`) diverge from the **name-based** identity (Biomapper name-only) and
the **curated reference**, what each competing HMDB ID actually is (official metadata), and why
each mismatch happens. Built as a new reproducible step in the existing
`analysis/ms1-biomapper-concordance/` harness plus a standalone Metabolon-facing export.

Delivered in two phases: a **deterministic core** (classification + metadata + structural verdict +
confidence-stratified error profile + export) that lands independently, and a **gated LLM
enrichment** phase (cause narration/adjudication) that ships only after a data-sharing
confirmation (see origin: blocking open question #1).

## Problem Frame

Prior finding: of 416 features where both the embedded spectral HMDB and Biomapper name-only
return an HMDB, 47% (197) disagree; in disagreements the spectral ID matches the curated reference
only ~6/176 vs name-only 164/176 — the spectral library hits are frequently isobaric/isomeric
mis-IDs (e.g. 1-methylnicotinamide's MS1 hit was *D-Limonene* at cosine ~0.90–0.97). Two review
caveats shape the work: the embedded HMDB is currently **modal-collapsed per name** (must move to
feature/spectrum grain), and the **curated reference is a fallible baseline** (with two curation
sources). (see origin: Problem Frame)

## Requirements Trace

- R1. Three-way agreement classification per embedded-HMDB feature (spectral / Biomapper name-only /
  curated reference), curation as a **fallible baseline**; explicit `no-curated-arbiter` and
  `spectral-disagrees-may-be-correct` states; multi-valued sides use set-overlap semantics.
- R2. Official metadata per competing HMDB ID, by ID, two-tier (MW `compound/hmdb_id` → PubChem PUG
  fallback), cached, with per-value source + retrieval date; chemical class best-effort.
- R3. Deterministic structural relation (same-structure / isomer / isobar) from InChIKey + formula +
  monoisotopic mass; LLM narrates cause + adjudicates **only the undetermined** with payload
  minimization (public facts + IDs + measured mz/adduct/cosine only).
- R4. Confidence-stratified aggregate error profile with explicit coverage denominator, framed as
  the "embedded-HMDB, name-parseable slice."
- R5. Two deliverables: (a) reproducible harness step (committed generator → enriched CSV + report
  section + notebook cell); (b) standalone Metabolon export = pure rendering layer over (a).
- R6. Provenance for all three sides (embedded: file/sheet/column/raw/cosine; Biomapper: join to
  `raw_name_only.json`; reference: `per_metabolite_annotation.csv`; metadata: source + date).
- R7. Validation spot-check gate (stratified N≈10–15); aggregate labeled provisional until passed.

## Scope Boundaries

- HMDB namespace only; CAS characterization out of scope for v1.
- Embedded-HMDB, name-parseable features only; broader Biomapper-vs-curation disagreements excluded.
- Deep enrichment on non-all-agree only; all-agree get counts.
- No re-mapping — reuse cached `raw_name_only.json` / `comparison.csv`. No bulk HMDB download.

### Deferred to Separate Tasks

- **LLM enrichment (Units 6–7)**: gated on the data-sharing confirmation (origin blocking question
  #1). Phase 1 (Units 1–5) is fully usable without it.

## Context & Research

### Relevant Code and Patterns

- `analysis/ms1-biomapper-concordance/refmet_api.py` — the exact pattern to mirror for R2: per-ID
  REST lookup against MW with an on-disk JSON cache and an injectable `fetch` for tests.
- `analysis/ms1-biomapper-concordance/input_hints.py` — `build_input_hints` parses HMDB via
  `HMDB\d+` from `ms1/ms2_compound_name`; **modal-collapses per name** (must be generalized to
  feature/spectrum grain for this work, preserving multiplicity + cosine).
- `analysis/ms1-biomapper-concordance/compare.py` — `classify()` set-overlap semantics
  (agree_exact/partial/disagree/new_coverage/missed/none) to reuse for multi-valued sides;
  `_index_by_name`, `write_*` CSV sanitization.
- `analysis/ms1-biomapper-concordance/report.py` — `aggregate()` + `_emit_ns_table`/render helpers;
  add the error-profile section here so the report and notebook stay in sync.
- `analysis/ms1-biomapper-concordance/run_comparison.py` — orchestrator; reads input/ground-truth/
  xlsx, reloads cached passes. Wire the new step in here.
- `analysis/ms1-biomapper-concordance/io_and_normalize.py` — `normalize_id`, `biomapper_ids`,
  `normalize_name`, `is_missing`.

### Institutional Learnings

- `docs/solutions/best-practices/csv-formula-injection-prevention-2026-05-23.md` — sanitize leading
  `= + - @` in any exported CSV (reuse `compare.sanitize_cell`).
- `docs/solutions/logic-errors/preserve-original-columns-and-hint-prefix-fix-2026-05-07.md` —
  join by name; preserve original columns; value-based namespace handling.

### External References

- Verified during review: MW `https://www.metabolomicsworkbench.org/rest/refmet/...` and
  `…/compound/hmdb_id/<id>/all/` (returns name/formula/exactmass/inchi_key/pubchem_cid; **no class**;
  ~13% of mismatch IDs miss); PubChem PUG `…/rest/pug/compound/...` resolves MW misses (e.g. L-Fucose).

## Key Technical Decisions

- **Feature/spectrum grain via a `matched_name` join (verified).** `comparison.csv` is **name-grain**
  (2,725 distinct names, ~1 feature_id per name); the per-method/per-feature embedded HMDBs +
  `ms1_cosine_score` live in the xlsx, where **~850/2,725 names span multiple feature_ids** and 50+
  names carry >1 embedded HMDB per sheet. Join xlsx feature rows to `comparison.csv` **on
  `matched_name`** (the only key that survives name grain), attach the name-level name-only/curated
  verdict to each feature row, dedupe embedded HMDB per `feature_id` — preserve multiplicity, never
  modal-collapse. Unit 4 aggregates count **features**, not name fan-out. (A `(feature_id, matched_name)`
  join would silently drop the alternate-method spectra this work exists to characterize.)
- **Curation arbiter = `per_metabolite_annotation.csv`** (primary). The xlsx `curation_chemical_id`
  is a **Metabolon-internal integer ID (not HMDB), sparse (~5–17%)** — carry it as **opaque
  presence-only provenance**, not a value-level divergence flag (comparing it to HMDB is meaningless
  without a Metabolon→HMDB resolution step, out of scope). **Reuse the curated side's
  `super/main/sub_class` + `formula` already present in `per_metabolite_annotation.csv`** rather than
  re-fetching (its `inchi_key` column is empty, 0/2,725, so curated InChIKey still comes from Unit 2).
- **Metadata by ID, two-tier**: MW `compound/hmdb_id` (tier 1) → PubChem PUG (tier 2). Class is
  best-effort via a HMDB→name→RefMet hop and may be null. Cache mirrors `refmet_api.py`. **Confirm
  the live MW/PubChem JSON field names against a real call before relying on the mapping** (verified
  offline only from the review note).
- **Deterministic verdict before LLM**: InChIKey settles same-structure; same formula + differing
  InChIKey = isomer; differing formula + ~equal monoisotopic mass = isobar; else undetermined.
  InChIKey/exactmass for the competing IDs come **only from Unit 2** (local InChIKey is empty), so
  verdict coverage is bounded by MW+PubChem hit rate — report an explicit
  **undetermined-due-to-missing-metadata** count and gate Phase-1 shipping on a measured
  **deterministic-verdict yield** (≥X% non-undetermined, X set at execution from the real 344-ID set).
  For the isobar branch, **both masses must come from the same source** (refuse the verdict on
  cross-endpoint masses; name the mass tolerance constant from the actual mass histogram).
- **`spectral-disagrees-may-be-correct` needs an evidence criterion, not a default flag.** Fire it
  only when the spectral ID's monoisotopic mass is consistent with the feature's measured
  `neutral_mass`/`adduct_type` while the curated ID's is not (or the two curation signals conflict).
  If no measured comparison is feasible in Phase 1, **rename it `curation-fallible-unassessed`** to
  avoid over-claiming.
- **LLM (Phase 2) is advisory + payload-minimized + OpenAI** (only `OPENAI_API_KEY` present). It
  **narrates cause** for isomer/isobar rows and **adjudicates only `undetermined`** rows (skips
  `same_structure`), may answer "insufficient evidence." Build the payload from an **explicit
  field allowlist** (public facts + IDs + `mean_mz`/`adduct_type`/`ms1_cosine_score`), never by
  filtering a wider dict — so a future column can't leak `matched_name`/`emb_raw`/`ref_hmdb`.
- **Standalone export = rendering layer** folded into `spectral_delta.py` (build/write functions
  mirroring `compare.build_mapped_final`/`write_mapped_final`); no separate module, no extra mapping/LLM calls.
- **New aggregator, not an extension of `report.aggregate`** — `report.aggregate` is hard-wired to the
  concordance `{ns}__*` schema; the spectrum-grain delta needs a **sibling `aggregate_spectral_delta`**
  + its own render helper (the notebook reuses that sibling to avoid drift).

## Open Questions

### Resolved During Planning

- Which curation is arbiter? → `per_metabolite_annotation.csv` primary; xlsx `curation_chemical_id`
  carried **opaque presence-only** (Metabolon-internal integer, not HMDB).
- LLM provider? → OpenAI (only key available); confirm ZDR tier at Unit 6.
- HMDB metadata source? → MW `compound/hmdb_id` + PubChem fallback (no bulk download); class
  best-effort; reuse curated class/formula from `per_metabolite_annotation.csv`.
- Embedded-ID grain + join? → feature/spectrum, preserve multiplicity + cosine; **join on `matched_name`**
  (comparison.csv is name-grain).
- Reproducibility / which run? → **run inline** in `run_comparison.py` on the in-memory `comp` + xlsx;
  no canonical-run ambiguity. Record the input data reference per run.

### Deferred to Implementation

- Deterministic-verdict **yield** on the real 344-ID set + the Phase-1 ship threshold (X%).
- Cosine-band boundary (from the actual histogram) + the no-cosine bucket handling.
- Isobar **mass-tolerance** constant (ppm/mDa) + the same-source-mass rule.
- Exact spot-check N/agreement bar (R7) — default N≈15, ≥90%; finalize at execution.
- Reliability of the HMDB→name→RefMet class hop — measure hit rate; drop class to null if poor.
- LLM prompt wording + structured-output schema (validated against the allowlist) — design at Unit 6.

### Blocking

- **Data-sharing/legal — covers ALL outbound third-party calls, not just the LLM.** Phase 2 (LLM):
  confirm the Metabolon agreement permits sending dataset-derived values to an external LLM on a
  confirmed **Zero-Data-Retention** OpenAI tier (ZDR is not the default). **Phase 1 also sends
  dataset-derived HMDB IDs to MW + PubChem (Unit 2)** — confirm that is permitted, or run only the
  offline cache-replay path, before the live metadata fetch.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
cached comparison.csv (HMDB__bmap, HMDB__ref, confidence_tier)
        + All_Methods_Features.xlsx (ms1/ms2_compound_name, ms2_cas_id, ms1_cosine_score, adduct, neutral_mass)
        + per_metabolite_annotation.csv (curated ref)  + xlsx curation_chemical_id (cross-check)
   │
   ▼
[spectral_delta]  per feature, FEATURE-GRAIN embedded HMDB set (+cosine, provenance)
   │              three-way classify {spectral, name-only, curated} via compare.classify set-overlap
   │              states incl no-curated-arbiter, spectral-may-be-correct → spectral_delta.csv
   ▼
[hmdb_api]   per distinct competing HMDB ID → {name, formula, mono_mass, inchikey, pubchem, class?, source, date}
   │         MW compound/hmdb_id  (tier1)  →  PubChem PUG (tier2)   [cached, like refmet_api]
   ▼
[structural_relation]  InChIKey/formula/mono_mass → same-structure | isomer | isobar | undetermined  (deterministic)
   ▼
[report/notebook]  confidence-stratified error profile + coverage denominator (Phase 1)
[metabolon_export] rendering layer → standalone report + enriched CSV (Phase 1: deterministic only)
   ┄┄┄┄ gate: data-sharing confirmation ┄┄┄┄
[llm_characterize] payload-min (public facts + IDs + mz/adduct/cosine) → category + narration + adjudication(undetermined)
[validation]       stratified spot-check → mark profile validated/provisional
```

## Implementation Units

### Phase 1 — Deterministic core (no LLM, no data-sharing gate)

- [ ] **Unit 1: Spectral-delta generator + three-way classification (committed harness step)**

**Goal:** Replace the ad-hoc mismatch query with a committed generator that builds, at
feature/spectrum grain, the three-way agreement table with provenance and spectral confidence.

**Requirements:** R1, R6

**Dependencies:** None (reads cached `comparison.csv` + xlsx + ground truth)

**Files:**
- Create: `analysis/ms1-biomapper-concordance/spectral_delta.py`
- Create: `analysis/ms1-biomapper-concordance/tests/test_spectral_delta.py`
- Modify: `analysis/ms1-biomapper-concordance/input_hints.py` (add feature-grain extraction; keep modal for the hinted pass)

**Approach:**
- Add a feature-grain embedded-ID extractor: per `feature_id`, the set of embedded HMDBs across its
  xlsx rows with frequency, `ms1_cosine_score`, and provenance (sheet/column/raw cell). Do **not**
  modal-collapse.
- Join xlsx feature rows to `comparison.csv` **on `matched_name`** (comparison.csv is name-grain;
  ~850 names span multiple feature_ids in the xlsx). Attach the name-level `HMDB__bmap` (name-only),
  `HMDB__ref` (curated), `confidence_tier` to **each feature-grain row**; dedupe embedded HMDB per
  `feature_id`. Reuse the curated side's `super/main/sub_class`+`formula` from `per_metabolite_annotation.csv`.
- Three-way classify with `compare.classify` set-overlap semantics across {spectral, name-only,
  curated}; emit states: all-agree, spectral-disagrees, biomapper-disagrees, all-differ,
  `no-curated-arbiter` (empty ref), and the evidence-gated `spectral-disagrees-may-be-correct`
  (renamed `curation-fallible-unassessed` if no measured criterion is feasible — see Key Decisions).
  Carry the xlsx `curation_chemical_id` as an **opaque presence-only** provenance column (not a
  value-divergence flag). Re-derive the no-arbiter count from the pinned run (the requirements'
  "21/197" predates the current artifact, which shows 0 empty refs — confirm at implementation).
- Write `spectral_delta.csv` (CSV-sanitized) with full provenance.

**Patterns to follow:** `compare.classify`, `compare._index_by_name`, `compare.sanitize_cell`, `refmet_api` caching style (n/a here), `input_hints` parsing.

**Test scenarios:**
- Happy path: a feature whose embedded HMDB == name-only == curated → all-agree.
- Edge: a feature with two distinct embedded HMDBs across methods → both preserved (no collapse), multiplicity recorded.
- Edge: a name spanning multiple feature_ids/sheets → **multiple** output rows (not collapsed to one); aggregates count features, not name fan-out.
- Edge: empty curated ref → `no-curated-arbiter` state, not crash.
- Edge: multi-valued name-only HMDB overlapping embedded on one ID → set-overlap classifies agree_partial.
- Edge: curation present, spectral disagrees → `spectral-disagrees` with may-be-correct flag default.
- Integration: row count and provenance columns match the cached comparison join; cosine carried through.

- [ ] **Unit 2: HMDB metadata resolver (by ID, two-tier, cached)**

**Goal:** Resolve each competing HMDB ID to official metadata via MW then PubChem, cached on disk.

**Requirements:** R2, R6

**Dependencies:** None (independent; consumed by Units 3–5)

**Files:**
- Create: `analysis/ms1-biomapper-concordance/hmdb_api.py`
- Create: `analysis/ms1-biomapper-concordance/tests/test_hmdb_api.py`

**Approach:**
- Mirror `refmet_api.resolve_refmet_names`: `resolve_hmdb_metadata(ids, cache_path, *, fetch=...)`
  returning `{hmdb_id: {name, formula, monoisotopic_mass, inchikey, pubchem_cid, class, link,
  source, retrieved}}`; injectable `fetch` for tests; misses cached.
- Tier 1: MW `compound/hmdb_id/<id>/all/` (name/formula/exactmass/inchi_key/pubchem_cid). Tier 2:
  PubChem PUG by name/pubchem for the ~13% MW misses. Link constructed `https://hmdb.ca/metabolites/<id>`.
- Class: best-effort via HMDB→name→RefMet `refmet/match/<name>/all/`; null on miss. Record `source`
  (mw / pubchem / refmet-class) and `retrieved` date per entry.

**Patterns to follow:** `refmet_api.py` (cache + injectable fetch + normalize), `io_and_normalize.normalize_id`.

**Test scenarios:**
- Happy path (mocked fetch): MW hit returns all fields; link constructed correctly.
- Edge: MW miss → PubChem fallback supplies formula/mass/inchikey; `source` records the tier used.
- Edge: both miss → entry cached with nulls, excluded gracefully; no exception.
- Edge: class hop returns nothing → class is null, other fields intact.
- Behavior: second call serves from cache, `fetch` not invoked (assert mock not called).

- [ ] **Unit 3: Deterministic structural relation**

**Goal:** Compute same-structure / isomer / isobar / undetermined for each mismatch's competing IDs from metadata facts — no LLM.

**Requirements:** R3 (deterministic part)

**Dependencies:** Unit 2 (metadata)

**Files:**
- Create: `analysis/ms1-biomapper-concordance/structural_relation.py`
- Create: `analysis/ms1-biomapper-concordance/tests/test_structural_relation.py`

**Approach:**
- `relation(meta_a, meta_b)` →: same InChIKey (or its skeleton block) → `same_structure`; differing
  InChIKey + same molecular formula → `isomer`; differing formula + |Δ monoisotopic mass| within a
  small tolerance → `isobaric`; missing InChIKey on either side → `undetermined`; else `unrelated`.
- Define the mass tolerance explicitly (e.g. nominal-mass equality / a ppm or mDa window) as a named constant.

**Patterns to follow:** pure-function style of `io_and_normalize` helpers; deterministic + unit-tested.

**Test scenarios:**
- Happy path: identical InChIKey → same_structure.
- Happy path: same formula, different InChIKey (e.g. 1- vs 3-methylhistidine, both C7H11N3O2) → isomer.
- Happy path: different formula, near-equal monoisotopic mass within tolerance → isobaric.
- Edge: one side missing InChIKey → undetermined (never guesses).
- Edge: clearly different formula and mass → unrelated.

- [ ] **Unit 4: Confidence-stratified error profile + report/notebook section**

**Goal:** Aggregate the delta into the error profile (by cause/structural relation, stratified by
spectral confidence band), with explicit coverage denominator, and render it in `report.md` + notebook.

**Requirements:** R4, R5(a)

**Dependencies:** Units 1–3

**Files:**
- Modify: `analysis/ms1-biomapper-concordance/report.py`
- Modify: `analysis/ms1-biomapper-concordance/explore.ipynb`
- Create: `analysis/ms1-biomapper-concordance/tests/test_spectral_delta_report.py`

**Approach:**
- Add a **sibling `aggregate_spectral_delta`** (do **not** extend `report.aggregate` — it's bound to
  the concordance `{ns}__*` schema) + a new render helper computing: matched-vs-not counts;
  structural-relation distribution (incl. an explicit **undetermined-due-to-missing-metadata** count);
  spectral-vs-curation correctness rate **stratified by `ms1_cosine_score` band** (choose the boundary
  from the actual cosine histogram; include a **no-cosine** bucket — cosine is sparse); coverage
  denominator (embedded-HMDB / name-parseable share of all features).
- Render a "Spectral-ID delta characterization" report section; the notebook cell calls the **new
  render path** on the delta table (no inline markdown) so report and notebook don't drift. Frame as
  the embedded-HMDB-parseable slice.

**Patterns to follow:** `report._emit_ns_table`, the existing per-tier/contribution sections; notebook reuses `report.aggregate`.

**Test scenarios:**
- Happy path: a fixture yields correct matched/not counts and structural-relation distribution.
- Edge: zero-comparable band → `n/a`, no divide-by-zero.
- Happy path: confidence stratification splits a high-cosine-wrong vs low-cosine row into the right bands.
- Edge: coverage denominator reported as a fraction of all features.

- [ ] **Unit 5: Standalone Metabolon export (deterministic rendering layer)**

**Goal:** Produce the shareable Metabolon artifact (summary + per-mismatch enriched table) as a pure
rendering layer over the enriched CSV — deterministic columns only in Phase 1.

**Requirements:** R5(b), R6

**Dependencies:** Units 1–4

**Files:**
- Modify: `analysis/ms1-biomapper-concordance/spectral_delta.py` (add `build_metabolon_export`/`write_metabolon_export`, mirroring `compare.build_mapped_final`/`write_mapped_final` — **no separate module**)
- Modify: `analysis/ms1-biomapper-concordance/run_comparison.py` (run the spectral-delta + export step **inline** in the same invocation that produced `comp`)
- Create: `analysis/ms1-biomapper-concordance/tests/test_metabolon_export.py`

**Approach:**
- Compose the delta table + `hmdb_api` metadata + `structural_relation` into one enriched table;
  render a standalone report (summary up top: matched-vs-not, structural-relation profile, coverage
  denominator) + the per-mismatch table. No mapping/LLM calls. Write a fixed **`PROVISIONAL` marker**
  into the export header (removed only after the Unit 7 spot-check). Pin a stable Phase-2 LLM
  placeholder **column name + sentinel** ("pending") so the CSV schema is stable when shared early.
- Wire into `run_comparison.py` to regenerate **inline each run** (operate on the in-memory `comp` +
  the xlsx; write into the same `outputs/<run>/`) — no cross-run ambiguity; outputs git-ignored.
- Reuse `compare.sanitize_cell`; carry the README confidentiality note into the export header.

**Patterns to follow:** `compare.write_mapped_final` (sanitized CSV writer), `run_comparison` orchestration + path printing.

**Test scenarios:**
- Happy path: enriched table joins delta + metadata + relation; original provenance columns preserved.
- Edge: a competing ID with null metadata renders blank cells, not errors.
- Integration: text cell starting with `=`/`+`/`-`/`@` is sanitized in the exported CSV.
- Behavior: export runs with zero API calls (assert no network) and is reproducible from cache.

### Phase 2 — LLM enrichment (GATED on data-sharing confirmation)

- [ ] **Unit 6: LLM cause characterization (payload-minimized, advisory)**

**Goal:** For undetermined/mismatch rows, add an LLM cause category + 1–2 sentence rationale, and an
adjudication only where the deterministic verdict + measured evidence don't settle it.

**Requirements:** R3 (LLM part)

**Dependencies:** Units 1–5; **data-sharing confirmation (blocking)**

**Files:**
- Create: `analysis/ms1-biomapper-concordance/llm_characterize.py`
- Create: `analysis/ms1-biomapper-concordance/tests/test_llm_characterize.py`

**Approach:**
- Provider = OpenAI (key from repo `.env` via python-dotenv; never printed). Add the SDK to the env.
- **Payload minimization:** prompt contains only public HMDB facts (name/formula/mass/class/InChIKey)
  for the competing IDs + the IDs + measured `mean_mz`/`adduct_type`/`ms1_cosine_score` — never
  `matched_name`, `emb_raw`, or curated `ref_hmdb`.
- Structured output: category from the fixed taxonomy (incl. `other`), optional adjudication
  (allow `insufficient_evidence`), confidence, rationale. Label outputs advisory. Cache per row.
- Invoked for `undetermined`/`isomer`/`isobaric` (skip `same_structure`): **narrate cause** for
  isomer/isobar; **adjudicate** which ID is correct **only for `undetermined`**. Build the prompt
  from an **explicit field allowlist** (never filter a wider dict, so a future column can't leak
  `matched_name`/`emb_raw`/`ref_hmdb`).

**Execution note:** Do not start until the data-sharing gate clears; build behind a flag so Phase 1 stays runnable.

**Patterns to follow:** `refmet_api` caching + injectable client (mock the LLM in tests); `run_pipeline.load_api_key` dotenv pattern.

**Test scenarios:**
- Happy path (mocked client): returns category + rationale; advisory label + confidence attached.
- Edge: deterministic `same_structure` rows are skipped (no LLM call).
- Edge: prompt payload asserted to contain **none** of `matched_name`/`emb_raw`/`ref_hmdb` (security).
- Edge: client returns malformed output → row flagged, run continues.
- Behavior: cached row served without a second client call.

- [ ] **Unit 7: Validation spot-check (PROVISIONAL marker + manual checklist) — deterministic part is Phase 1**

**Goal:** Keep the export marked PROVISIONAL until a human spot-check passes — lightweight, no
programmatic label-toggle infrastructure. The **deterministic** spot-check runs in **Phase 1** (no
LLM, no data-sharing gate); the LLM-adjudication spot-check extends it in Phase 2.

**Requirements:** R7

**Dependencies:** Unit 5 (Phase-1 deterministic part); Unit 6 (Phase-2 LLM part)

**Files:**
- Modify: `analysis/ms1-biomapper-concordance/spectral_delta.py` (the `PROVISIONAL` marker constant written into the export header)
- Modify: `analysis/ms1-biomapper-concordance/README.md` (the stratified spot-check checklist + how/when to clear the marker)

**Approach:**
- The export carries the `PROVISIONAL` marker unconditionally (written in Unit 5). A reviewer manually
  checks a **stratified sample (N≈15 default, across structural-relation categories + cosine bands)**
  against the facts, records outcomes, and clears the marker only when an agreement bar (default ≥90%)
  is met. **No programmatic label-flipping module/test** — the marker is the gate; distribution
  discipline (share only via the original channel) is documented.
- Phase 1 validates the **deterministic verdicts**; Phase 2 extends the checklist to the **LLM
  cause/adjudication** outputs.

**Test scenarios:**
- Test expectation: none — operational checklist + a header-marker constant. The marker-present-by-default behavior is covered by Unit 5's export test.

## System-Wide Impact

- **Interaction graph:** Self-contained under `analysis/ms1-biomapper-concordance/`; new modules
  consumed by `run_comparison.py`. No biomapper-ui app code touched. No new Biomapper API calls.
- **Error propagation:** Metadata/LLM lookups degrade to nulls/flags, never abort the run; deterministic
  relation never guesses (undetermined on missing facts).
- **State lifecycle risks:** All new caches (`hmdb_*`, LLM) live under git-ignored `outputs/`; reproducible from cache.
- **API surface parity:** None — internal analysis only.
- **Integration coverage:** Generator↔cache join, two-tier metadata fallback, payload-minimization, and export-from-cache are integration-tested with mocked fetch/clients.
- **Unchanged invariants:** Existing concordance harness (`compare`/`report`/`run_comparison` name-only + hinted) behavior preserved; `input_hints` modal behavior for the hinted pass unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Sending Metabolon data to an external LLM (legal/privacy) | Phase-2 gated on data-sharing confirmation; payload minimized to public facts + IDs; OpenAI key from .env; advisory labeling |
| MW misses ~13% of HMDB IDs | PubChem PUG tier-2 fallback; null + flagged if both miss (Unit 2) |
| Chemical class needs a fuzzy HMDB→name→RefMet hop | Class is best-effort/nullable; doesn't block other fields |
| LLM confidently wrong on identity | Deterministic InChIKey/formula/mass verdict first; LLM only narrates/adjudicates undetermined; spot-check gate (R7); advisory label |
| Curation baseline itself wrong | Curation treated as fallible; `spectral-may-be-correct` + `no-arbiter` states; xlsx curation cross-check column |
| Modal-collapse hides real per-feature calls | Feature/spectrum grain extraction preserves multiplicity + cosine (Unit 1) |
| Biased "library error profile" framing | Explicit coverage denominator; framed as embedded-HMDB-parseable slice (Unit 4) |
| Export leaks unpublished data | git-ignored outputs; README confidentiality note in export header; share only via original channel |
| (feature_id, matched_name) join drops feature-grain multiplicity | Join on `matched_name`; attach name-level verdict to each feature row; aggregates count features (Unit 1) |
| Deterministic verdicts mostly `undetermined` (InChIKey misses) → Phase 1 empty | Report undetermined-due-to-missing-metadata; gate Phase-1 ship on measured verdict yield; reuse curated class/formula locally |
| Phase-1 MW/PubChem calls also disclose dataset-derived IDs | Data-sharing question covers all outbound calls; offline cache-replay path; confirm before live fetch |
| Export shared while still PROVISIONAL | PROVISIONAL marker in header by default; Phase-1 deterministic spot-check clears it; documented distribution discipline |
| Cross-endpoint mass precision → false isobars | Both masses from same source; refuse isobar verdict otherwise (Unit 3) |

## Documentation / Operational Notes

- Update `analysis/ms1-biomapper-concordance/README.md`: the spectral-delta step, the HMDB metadata
  source (MW+PubChem by ID), the deterministic-vs-LLM split, the Phase-2 gate, and export handling.
- Outputs (delta CSV, metadata cache, export) are git-ignored; the export is shared with Metabolon
  only via the original channel.

## Phased Delivery

### Phase 1 (lands independently)
- Units 1–5 + the **deterministic** part of Unit 7 (PROVISIONAL marker + manual spot-check of the
  deterministic verdicts). Answers **what** each ID is and the **structural relation** (isomer/isobar/…);
  the causal **why** narration is Phase 2 — frame the Phase-1 deliverable accordingly, don't over-claim
  it answers Metabolon's "why." Note the data-sharing question **also covers the Phase-1 MW/PubChem
  lookups** (confirm before the live fetch; cache-replay runs offline).

### Phase 2 (after data-sharing confirmation)
- Unit 6 (LLM cause narration/adjudication, payload-minimized) + the LLM part of Unit 7's spot-check.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-06-10-spectral-id-delta-characterization-requirements.md](docs/brainstorms/2026-06-10-spectral-id-delta-characterization-requirements.md)
- Related code: `analysis/ms1-biomapper-concordance/{compare,report,run_comparison,refmet_api,input_hints,io_and_normalize}.py`
- Prior artifact: `outputs/<run>/embedded_vs_nameonly_mismatches.csv` (ad-hoc; superseded by Unit 1's committed generator)
