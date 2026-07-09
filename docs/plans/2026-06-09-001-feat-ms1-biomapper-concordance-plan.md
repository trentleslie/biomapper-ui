---
title: "feat: Run the reference's MS1-annotated analytes through Biomapper and compare against his curated annotations"
type: feat
status: active
date: 2026-06-09
deepened: 2026-06-09
---

# feat: MS1 Analyte ↔ Biomapper Concordance Study

## Overview

The input dataset is a set of LC-MS features with name annotations; the task is to (1) run them
through the Biomapper pipeline and (2) compare Biomapper's cross-database identifiers
against his own curated annotations. This plan builds a small, reproducible analysis
harness that maps 2,725 metabolite names via the `biomapper` SDK (two passes: name-only
and hinted), joins the results back to the curated reference IDs, and produces a per-feature
comparison CSV, a markdown concordance report, and an interactive notebook.

This is a one-off analysis deliverable, not a change to the biomapper-ui product. All
code and outputs live in a self-contained `analysis/ms1-biomapper-concordance/` directory.

## Problem Frame

The input dataset comprises three files:

- `unique_features_by_best_tier.csv` — 2,725 rows: `feature_id, matched_name, match_level`.
  The deduplicated "best name per feature" list. **This is the input to map.**
- `per_metabolite_annotation.csv` — the same 2,725 rows plus the reference's curated annotation
  columns (`refmet_name, super_class, main_class, sub_class, formula, kegg_id, hmdb_id,
  chebi_id, lipidmaps_id, pubchem_cid`, pathways, etc.). **This is the comparison ground truth.**
- `All_Methods_Features.xlsx` — 4 sheets (`Method1` 2484, `Method2` 4166, `Sheet3` 3502,
  `Sheet4` 2065 rows) of raw feature-level data (mz/ri, MS1/MS2/curation annotations).
  **Supporting context** for per-method / per-tier breakdowns in the notebook.

The question: how well does Biomapper reproduce the curation, where does it
disagree, and where does it add coverage the reference lacks?

Established facts (verified during planning):
- The two CSVs are 1:1 on feature set (same 2,725 rows). Tiers: MS2=1889, CURATION=683, MS1=153.
- Reference ID coverage: ChEBI 1172, PubChem 1180, RefMet 1242, HMDB 1056, KEGG 670,
  LipidMaps 332, InChIKey 0. ~Half the features have no IDs → real room for Biomapper to add coverage.
- `feature_id` is **not unique**: 2,725 rows but only 2,710 distinct IDs (15 duplicated). Join must use `(feature_id, matched_name)`.
- Biomapper "pipeline" = the `biomapper` Python SDK (v1.2.1, remote HTTP client to the
  BioMapper2 API). Most direct call: `biomapper.map_entities([{"name": ...}, ...])`.

## Requirements Trace

- R1. Run all 2,725 named features through Biomapper to obtain cross-database identifiers.
- R2. Run **two passes**: name-only (the authoritative comparison) and hinted (the reference's existing IDs as resolver hints). **Concordance/agreement metrics come from the name-only pass only.** The hinted pass is reported solely as (a) resolution-rate lift — names unresolved name-only that resolve with a hint — and (b) optional *cross-namespace* agreement on namespaces NOT supplied as a hint for that feature. Hinted-namespace agreement is labeled "echo, not validated" and never counted as concordance (it is circular).
- R3. Join Biomapper output to the curated reference annotations by `(feature_id, matched_name)`.
- R4. Per identifier namespace, classify each feature as agree_exact / agree_partial / disagree / new-coverage (Biomapper-only) / missed (curated-only) / none, using normalized IDs, recording Biomapper candidate-set cardinality and the resolved entity name.
- R5. Produce a per-feature comparison CSV, a markdown concordance report (name-only rates by namespace × tier with a sized denominator; disagreement + confident-wrong examples; new-coverage by confidence tier; hinted lift), and an exploration notebook (per-method breakdowns live here).
- R6. Persist raw pipeline results to disk by default in a timestamped output dir (expensive paid-API run — reproducibility SOP).
- R7. Make agreement honest: distinguish exact (1:1) vs partial (overlap within a multi-ID set), report the comparable-subset denominator explicitly and sized, and stratify every rate by tier.
- R8. Treat new-coverage as **unvalidated candidates**: stratify by confidence tier and spot-check a random sample; never present raw new-coverage counts as validated value.

## Scope Boundaries

- Not modifying the biomapper-ui app, its FastAPI backend, or the `biomapper` SDK.
- Not building a UI; this is a script + report + notebook.
- RefMet **is** a first-class scored namespace (it is the reference's best-covered field, 1242). Biomapper returns only `refmet_id`; the reference has only `refmet_name` — so bridge via the **RefMet master list downloaded once from Metabolomics Workbench into git-ignored `data/` (pin the version), resolved offline** (no per-row API calls). That same master list supplies RefMet class columns, so it also powers the class axis below. If the list is unavailable, fall back to ID-only RefMet (skip name bridging) and note the limitation.
- Chemical-class concordance (super/main/sub_class): a **secondary axis**. the reference classes are RefMet classes, so derive Biomapper's class from its `refmet_id` via the **same RefMet master list** — *not* ClassyFire (InChIKey coverage is 0, so an InChIKey→ClassyFire path won't work). Quantify how many features have a class but no ID; **if fewer than a stated threshold qualify, write a one-line note in `report.md` and skip the axis**.

### Deferred to Separate Tasks

- Resolving disagreements into corrected annotations (a curation decision for the reference, not this harness): future iteration.
- Feeding alternative name columns from the xlsx (`ms1_clean_name`, `ms2_compound_name`, `curation_compound_name`) as fallback retries for unresolved names: **out of scope for v1**, a clean follow-up if name-only resolution is poor.

## Context & Research

### Relevant Code and Patterns

- `biomapper` SDK (installed from `../biomapper`, v1.2.1). Key API:
  - `map_entities(records, *, entity_type="biolink:SmallMolecule", annotation_mode="missing", annotators=None, progress=False)` → `list[MappingResult]`. Auto-chunks at 1,000/request.
  - `MappingResult`: `.query_name`, `.resolved`, `.primary_curie`, `.confidence_score`, `.confidence_tier`, `.identifiers` (`dict[str, list[str]]` keyed by native CURIE prefix), `.kg_equivalent_ids`, `.error`; helpers `.ids_for(prefix)`, `.equivalent_ids_for(prefix)`.
  - `summarize(results)` for resolved/total.
- Record shape for hints: `{"name": str, "identifiers": {"HMDB": "HMDB0000177", "CHEBI": "15971", ...}}`.
- Reference script for a working setup: `artifacts/python-api/scripts/verify_api.py`.
- Tutorial: `../biomapper/notebooks/biomapper_tutorial.ipynb` (batch mapping, confidence tiers, file upload).

### Institutional Learnings

- `docs/solutions/logic-errors/biomapper-sdk-dict-list-data-loss-2026-05-06.md` — `identifiers`/`kg_equivalent_ids` is a `dict[str, list[str]]` keyed by native CURIE prefix; calling `list()` on it discards all IDs (use `dict(...)`). Empty dict `{}` is a valid "no match" but falsy — guard with `is not None`, not truthiness, or unmatched features silently drop. **Caveat (feasibility review):** the SDK accessors `ids_for`/`equivalent_ids_for` do a plain **case-sensitive** dict lookup — match the SDK's exact key casing (do *not* assume case-insensitive). And `identifiers` vs `kg_equivalent_ids` use *different* key conventions (e.g. LipidMaps is `LIPIDMAPS` in `identifiers` but `LM` in `kg_equivalent_ids`) — dump both dicts' keys from a real smoke run before trusting any namespace map.
- `docs/solutions/logic-errors/preserve-original-columns-and-hint-prefix-fix-2026-05-07.md` — never infer a namespace from a column *name*; detect from cell *values* (HMDB/CHEBI/KEGG/LIPIDMAPS/RefMet/PubChem patterns). Join Biomapper output to source rows by the entity-name column; keep original columns for reconciliation.
- `docs/solutions/developer-experience/biomapper-ui-deploy-cycle-2026-04-23.md` — name resolution returns confident-but-wrong matches fast (e.g., "Glucose" → "Blood Glucose" via MESH). Validate against ground-truth fixtures, not non-empty checks. Confirm which backend/API key the run hits before trusting results.
- `docs/solutions/best-practices/csv-formula-injection-prevention-2026-05-23.md` — sanitize leading `= + - @` in any CSV export of metabolite names (RFC-4180 quoting is insufficient).

### External References

- None used. Internal tooling with strong local patterns; external research adds no value here.

## Key Technical Decisions

- **Map via the `biomapper` SDK directly** (`map_entities`), not the UI backend or REST endpoints — most direct path for a batch script, no server required.
- **Two passes (R2):** name-only is the **authoritative** pass and the *only* source of concordance metrics. Hinted is secondary — report resolution lift and cross-namespace (un-hinted) agreement only. Run name-only first; the hinted pass is optional and never feeds an agreement number for a namespace it was hinted on (circularity firewall). Even cross-namespace (un-hinted) agreement is only as independent as the underlying cross-reference databases are disjoint from the reference curation source — label it "corroboration, provenance-dependent", not validation.
- **Dedupe by `matched_name` before calling the API** — map each distinct name once, then fan results back to all rows sharing that name. Saves paid API calls.
- **Join on `(feature_id, matched_name)`** because `feature_id` has 15 duplicates.
- **Normalize IDs per namespace before comparison:** HMDB zero-pad to `HMDB` + 7 digits (`HMDB00177` ↔ `HMDB0000177`); ChEBI strip `CHEBI:` prefix → bare number; KEGG uppercase `Cxxxxx`; PubChem cast to int string; LipidMaps uppercase. the reference's values are bare (`174627`, `C00152`, integers); Biomapper `ids_for("CHEBI")` returns bare too — normalize both sides through the same function.
- **Namespace ↔ column map:** `hmdb_id→HMDB`, `chebi_id→CHEBI`, `kegg_id→KEGG.COMPOUND`, `lipidmaps_id→LIPIDMAPS`, `pubchem_cid→PUBCHEM.COMPOUND`, plus `refmet_name`↔`refmet_id` (the SDK's RefMet key is the lowercase **`refmet_id`**, not `RefMet` — bridged offline via the RefMet master list). RefMet **is** scored.
- **Identifier source precedence:** prefer `result.identifiers[prefix]`; fall back to `kg_equivalent_ids[<prefix>]` for broader coverage. Guard absence with `is not None`. Use **two separate prefix maps** — one for `identifiers` (vocab keys like `LIPIDMAPS`) and one for `kg_equivalent_ids` (CURIE prefixes like `LM`) — confirmed against a live response, because the two dicts key differently.
- **Per-feature classification** for each namespace: both have IDs with **exact** single↔single match → `agree_exact`; both have IDs overlapping within a multi-ID set → `agree_partial`; both have IDs, no overlap → `disagree`; only Biomapper → `new_coverage`; only reference → `missed`; neither → `none`. Also record Biomapper's candidate-set **cardinality** per namespace, and carry `resolved` + the resolved entity name into every row so `none`/`new_coverage` split into "resolved-but-no-ID-here" vs "failed-to-resolve", and `new_coverage` whose resolved name diverges from `matched_name` is flagged a **confident-but-wrong candidate**.
- **Persist raw results by default** to `analysis/ms1-biomapper-concordance/outputs/<timestamp>/` (timestamp passed in, since `datetime.now()` is fine in execution; SOP from global CLAUDE.md). **Re-run reuse is a simple reload, not a cache abstraction:** write a stable `outputs/raw/<pass>_<base_url-hash>.json` once and reload it if present, so re-runs skip the paid API. No names+hints hashing layer (over-engineered for a one-off). Keep all raw/reload artifacts inside the git-ignored `outputs/` tree.

## Open Questions

### Resolved During Planning

- Which file is input vs ground truth? → `unique_features_by_best_tier.csv` (names) is input; `per_metabolite_annotation.csv` (IDs) is ground truth. (They're the same 2,725 features.)
- Name-only vs hinted? → Both (user decision).
- Deliverable? → CSV + markdown report + Jupyter notebook (user decision).
- Join key? → `(feature_id, matched_name)`; `feature_id` alone is non-unique.
- Hinted-pass circularity? → Firewalled: name-only is the sole concordance metric; hinted reported only as resolution lift + cross-namespace (un-hinted) agreement (review decision).
- RefMet scored? → Yes, promoted to a first-class namespace via name↔id resolution (review decision).
- Code structure / deliverables? → Keep the modular layout and all three deliverables (CSV + report + notebook); only the hash-cache was simplified to a reload (user + review decision).

### Deferred to Implementation

- RefMet bridge **direction** (resolve Biomapper id→name vs the reference name→id) — pick after dumping a sample of Biomapper RefMet output; the decision *to* score RefMet is settled.
- Whether `annotators` should be restricted (e.g., `["metabolomics-workbench"]` for RefMet-only) to reduce confident-but-wrong fuzzy matches — evaluate after a first name-only run against ground truth.
- Whether the BioMapper2 API honors **non-HMDB** hint keys (CHEBI/KEGG/LIPIDMAPS/PubChem) — probe before trusting multi-namespace hint-lift; if only HMDB is honored, scope the lift claim to HMDB.
- Whether enough features have a chemical class but no ID to justify the class-concordance axis — quantify at load time.
- The 15 duplicate `feature_id`s — confirm at load that duplicates carry distinct `matched_name`s (expected) and warn otherwise.

## Output Structure

    analysis/ms1-biomapper-concordance/
    ├── README.md                  # how to set up env + API key and run
    ├── data/                      # copies of the 3 input files — GIT-IGNORED (the unpublished input data; never commit)
    ├── io_and_normalize.py        # load inputs, build hints, ID normalization
    ├── run_pipeline.py            # two-pass map_entities + raw-result persistence + reload
    ├── compare.py                 # join + per-namespace classification → comparison CSV
    ├── report.py                  # concordance metrics + markdown report
    ├── run_comparison.py          # top-level orchestrator (ties units together)
    ├── explore.ipynb              # interactive notebook
    ├── tests/
    │   ├── test_normalize.py
    │   ├── test_run_pipeline.py   # biomapper client mocked
    │   ├── test_compare.py
    │   └── test_report.py
    └── outputs/<timestamp>/       # raw results JSON, comparison CSV, report.md (git-ignored)

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
inputs (3 files)
   │
   ▼
[io_and_normalize]  load curated rows (feature_id, matched_name, IDs)
   │                build {name -> hint dict} from the reference IDs
   │                dedupe distinct matched_names
   ▼
[run_pipeline]  pass A: map_entities([{name}])  (AUTHORITATIVE)  ─┐ persist raw JSON
                pass B: map_entities([{name, identifiers}]) lift ─┘ to outputs/<ts>/
   │            (reload persisted raw JSON on re-run; skip paid API)
   ▼
[compare]  fan results back to all rows by matched_name
   │       join to curated rows by (feature_id, matched_name)
   │       per namespace: normalize → classify exact/partial/disagree/new/missed/none
   ▼       → comparison.csv  (one row/feature; name-only authoritative, hinted labeled lift)
[report]  aggregate (name-only): rate by namespace × tier (exact/partial), sized denominator;
   │       disagreement + confident-wrong examples; new-coverage by tier; hinted = lift only
   ▼       → report.md   (per-method breakdown lives in the notebook)
[explore.ipynb]  interactive slice/dice + per-method breakdown over comparison.csv + raw + xlsx
```

## Implementation Units

- [ ] **Unit 1: Input loading, hint building, and ID normalization**

**Goal:** Load the curated annotations and feature list, build per-name hint dicts, and provide per-namespace ID normalization used by both the pipeline (hints) and comparison.

**Requirements:** R1, R3

**Dependencies:** None

**Files:**
- Create: `analysis/ms1-biomapper-concordance/io_and_normalize.py`
- Create: `analysis/ms1-biomapper-concordance/tests/test_normalize.py`

**Approach:**
- Load `per_metabolite_annotation.csv` as the master table (names + curated IDs); treat `NA`/empty as missing.
- Provide `load_features()` returning rows with `feature_id, matched_name, match_level` and the curated ID columns.
- `build_hints(row)` → `{"HMDB": ..., "CHEBI": ..., "KEGG.COMPOUND": ..., "LIPIDMAPS": ..., "PUBCHEM.COMPOUND": ...}` from non-missing curated IDs, normalized.
- `normalize_id(namespace, value)` implementing the per-namespace rules in Key Technical Decisions; returns canonical form or `None`.
- `distinct_names(rows)` for dedup before mapping.

**Patterns to follow:**
- Namespace keying with **exact (case-sensitive)** prefixes per `biomapper-sdk-dict-list-data-loss` learning; two separate maps for `identifiers` vs `kg_equivalent_ids`.
- Value-based (not column-name-based) namespace handling per `preserve-original-columns-and-hint-prefix-fix`.

**Test scenarios:**
- Happy path: HMDB `HMDB00177` and `HMDB0000177` both normalize to the same canonical 11-char form.
- Happy path: ChEBI `CHEBI:15971` and `15971` normalize equal; KEGG `c00152`→`C00152`; PubChem `5463.0`/`5463`→`5463`.
- Edge case: `NA`, empty string, and `None` all normalize to `None` and are excluded from hints.
- Edge case: `build_hints` on a fully-unannotated row returns `{}` (not `None`).
- Edge case: a name appearing on multiple `feature_id`s is reported once by `distinct_names`.
- Edge case: the 15 duplicate `feature_id`s are detected and reported at load (warn), confirming each carries a distinct `matched_name`.
- Edge case: count of features that have a chemical class but no curated ID is computed (gates the class-concordance axis).

**Verification:** Normalization is symmetric across reference-format and Biomapper-format IDs; hint dicts contain only populated, normalized namespaces.

- [ ] **Unit 2: Two-pass pipeline runner with default result persistence**

**Goal:** Map distinct names through `biomapper.map_entities` in both name-only and hinted passes, persisting raw results to a timestamped dir and caching to avoid re-hitting the paid API.

**Requirements:** R1, R2, R6

**Dependencies:** Unit 1

**Files:**
- Create: `analysis/ms1-biomapper-concordance/run_pipeline.py`
- Create: `analysis/ms1-biomapper-concordance/tests/test_run_pipeline.py`

**Approach:**
- `run_pass(names, hints_by_name=None, *, out_dir, progress=True)` → list of normalized result dicts (`query_name`, `resolved`, `primary_curie`, `confidence_tier`, `confidence_score`, `identifiers` as `dict(...)`, `kg_equivalent_ids`). Read `confidence_tier` **explicitly** — it is a computed property, not a model field, so a plain `model_dump()` drops it.
- Build records: name-only `[{"name": n}]`; hinted `[{"name": n, "identifiers": hints_by_name[n]}]`.
- Read raw `MappingResult` via SDK; copy `identifiers` with `dict(...)` (not `list()`); keep empty dicts.
- **Persist by default:** write `outputs/<timestamp>/raw_name_only.json` and `raw_hinted.json` as soon as each pass completes; print the path. Timestamp is passed in by the orchestrator.
- **Reload, not cache:** write `outputs/raw/<pass>_<base_url-hash>.json` once; on re-run, reload it if present and skip the paid API. No names+hints hashing. Keep artifacts in the git-ignored `outputs/` tree.
- Distinguish **per-entry** errors (one no-match in a good batch) from **whole-chunk** failures (the SDK stamps the same `error` on all up-to-1000 records in a failed chunk and returns them inline in a flat list — there is no chunk handle). On failure, **collect the errored `query_name`s and re-submit just those** (optionally smaller chunks, capped retries), merging by name — rather than persisting 1000 errored records. Surface per-record `error` and an overall resolved/total summary; never abort the whole run on individual errors.
- Alt-name fallback retries are **out of scope for v1** (see Scope Boundaries).

**Execution note:** Requires `biomapper>=1.2.1` installed in the active env and `BIOMAPPER_API_KEY` set (and correct `BIOMAPPER_BASE_URL`). Confirm which backend is targeted before trusting output (per deploy-cycle learning).

**Patterns to follow:**
- `dict(...)` copy + `is not None` guards (`biomapper-sdk-dict-list-data-loss`).
- `artifacts/python-api/scripts/verify_api.py` for client setup.

**Test scenarios:**
- Happy path (mocked client): N distinct names → N normalized result dicts; `identifiers` preserved as dict with all namespaces intact.
- Integration (mocked): a result with `identifiers={}` is retained (not dropped) and classified later as unresolved/no-id.
- Error path: one record returns `error` set → that record is flagged but the pass still returns all others.
- Behavior: raw JSON is written to `out_dir` even when the caller passes no explicit output flag (default-on persistence).
- Behavior: second invocation reloads `outputs/raw/<pass>_<base_url-hash>.json` and makes zero client calls (assert mock not called).
- Error path: a mocked whole-chunk failure triggers a chunk retry, not 1000 persisted error records.
- Probe: a single name where an HMDB hint changes resolution vs a CHEBI-only hint, confirming the API honors non-HMDB hints (gates the hint-lift claim).

- [ ] **Unit 3: Comparison engine (join + per-namespace classification)**

**Goal:** Fan pass results back to all feature rows, join to curated annotations, and classify each namespace per feature into agree/disagree/new_coverage/missed/none.

**Requirements:** R3, R4

**Dependencies:** Units 1, 2

**Files:**
- Create: `analysis/ms1-biomapper-concordance/compare.py`
- Create: `analysis/ms1-biomapper-concordance/tests/test_compare.py`

**Approach:**
- Index pass results by `query_name`; fan back to every `(feature_id, matched_name)` row sharing that name.
- For each scored namespace (incl. RefMet via name↔id), normalize the reference ID(s) and Biomapper's `ids_for`/`equivalent_ids_for` set, then classify into `agree_exact`/`agree_partial`/`disagree`/`new_coverage`/`missed`/`none` (see Key Decisions). Record candidate-set cardinality and the resolved entity name.
- Emit one row per feature with, per namespace: reference ID(s), Biomapper **name-only** ID(s), class label, candidate cardinality; plus `resolved`, resolved-name, `confidence_tier`, `primary_curie`. Hinted-pass columns are kept separate and clearly labeled (lift only, never concordance).
- Write `comparison.csv` to the timestamped output dir, with CSV-formula-injection sanitization on any name/text cells.

**Patterns to follow:**
- Join-by-name + keep-original-columns (`preserve-original-columns-and-hint-prefix-fix`).
- CSV sanitization (`csv-formula-injection-prevention`).

**Test scenarios:**
- Happy path: reference HMDB `HMDB0000177`, Biomapper `HMDB00177` → `agree` after normalization.
- Happy path: different normalized IDs in same namespace → `disagree`.
- Edge case: Biomapper has ChEBI, the reference has none → `new_coverage`; reverse → `missed`; neither → `none`.
- Edge case: duplicate `feature_id` with two distinct `matched_name`s produces two correctly-joined rows.
- Edge case: single↔single match → `agree_exact`; overlap within a multi-ID Biomapper set → `agree_partial` (cardinality recorded), distinct from exact.
- Edge case: `new_coverage` where the resolved entity name diverges from `matched_name` is flagged a confident-but-wrong candidate.
- Edge case: a resolved name with no ID in a namespace → `none` tagged "resolved-no-id", distinct from unresolved.
- RefMet: Biomapper `refmet_id` resolved to a name via the master list matches the reference `refmet_name` → `agree_exact`; a master-list miss is recorded as a bridge failure, distinct from `disagree`.
- Error path: a feature whose name had a pipeline `error` is marked unresolved across all namespaces, not crashed.
- Integration: a metabolite-name cell beginning with `=`/`+`/`-`/`@` is sanitized in the written CSV.

- [ ] **Unit 4: Concordance metrics and markdown report**

**Goal:** Aggregate the comparison into honest concordance rates and a readable markdown report.

**Requirements:** R5, R7, R8

**Dependencies:** Unit 3

**Files:**
- Create: `analysis/ms1-biomapper-concordance/report.py`
- Create: `analysis/ms1-biomapper-concordance/tests/test_report.py`

**Approach:**
- Compute (**name-only pass only**), per namespace: resolution rate; **exact** and **partial** agreement rates over an explicitly-stated, **sized** comparable denominator (features where both sides have an ID). Print the comparable-subset size **as a fraction of all features** in that namespace/tier (e.g., "71% over 480 pairs = 18% of 2,725"), and state explicitly that concordance describes only the double-annotated subset and says nothing about the ID-poor half (covered by new-coverage R8 and missed).
- Stratify every rate by tier (MS1/MS2/CURATION) so the easy/hard skew is visible.
- Report the **partial-agreement** rate broken down by Biomapper candidate-set cardinality bucket (2, 3–5, 6+), or with median cardinality, so partials inflated by large candidate sets are visible rather than pooled.
- **New-coverage honesty (R8):** break `new_coverage` down by confidence tier and spot-check a random sample of **≥20–30 per tier**, reporting estimated precision **with an approximate confidence interval** (not a bare count); below a stated precision floor, label that tier's new coverage "unreliable" rather than "candidate coverage".
- Hinted pass: report resolution **lift** only (names unresolved name-only, resolved with hint) and cross-namespace (un-hinted) agreement; explicitly exclude hinted-namespace agreement as circular.
- Surface top disagreement examples and confident-but-wrong candidates (high confidence + name divergence).
- Method-level breakdown (joining `feature_id` to the xlsx sheets, where a feature may appear in multiple methods) lives in the **notebook**, not the core report.
- Render `report.md` to the timestamped output dir.

**Patterns to follow:**
- Ground-truth-based validation framing (`biomapper-ui-deploy-cycle`) — report agreement, not just "ran successfully."

**Test scenarios:**
- Happy path: a fixture of mixed classifications yields correct exact and partial agreement rates with the sized denominator printed.
- Edge case: a namespace with zero comparable pairs reports `n/a` rather than dividing by zero.
- Edge case: tier buckets with no rows are omitted or shown as empty, not errored.
- Happy path: lift section reflects hinted resolution gain; a hinted-namespace agreement is excluded from concordance (circularity firewall verified).
- Edge case: `new_coverage` is reported split by confidence tier, never as a single "validated" total.

- [ ] **Unit 5: Orchestrator, notebook, and README**

**Goal:** A single entry point to run the whole study, an exploration notebook, and setup docs.

**Requirements:** R5, R6

**Dependencies:** Units 1–4

**Files:**
- Create: `analysis/ms1-biomapper-concordance/run_comparison.py`
- Create: `analysis/ms1-biomapper-concordance/explore.ipynb`
- Create: `analysis/ms1-biomapper-concordance/README.md`

**Approach:**
- `run_comparison.py`: stamp a timestamped `outputs/<ts>/`, **print the target `base_url`** (confirm dev vs prod before trusting results), run both passes, comparison, and report; print all artifact paths at the end (SOP). `--out` overrides the dir; persistence is default-on regardless.
- `explore.ipynb`: load `comparison.csv` + raw JSON + the 4 xlsx sheets; cells for per-namespace/tier/method breakdowns, disagreement drill-down, and new-coverage browsing. Clear output cells before committing (`jupyter nbconvert --clear-output --inplace`) so no key or raw data is persisted in the `.ipynb`.
- `README.md`: env setup (`pip install biomapper>=1.2.1`; **load `BIOMAPPER_API_KEY` via `python-dotenv` from the existing repo `.env` rather than `export`-ing it on the command line**, to avoid leaking it into shell history; optional `BIOMAPPER_BASE_URL`), how to run, where outputs land, and how to read the report. Never print or log the key.

**Test scenarios:**
- Test expectation: none — orchestration/glue, notebook, and docs. Behavior is covered by Units 1–4 tests; verify by a smoke run on a small name subset.

**Verification:** A smoke run on a fixed 20-name subset produces a timestamped dir with `raw_name_only.json`, `raw_hinted.json`, `comparison.csv`, `report.md`; assert `comparison.csv` row count == input feature rows for the subset and raw-JSON record count == distinct names; the notebook executes top-to-bottom without error against those artifacts.

## System-Wide Impact

- **Interaction graph:** Self-contained under `analysis/`. Consumes the `biomapper` SDK and the BioMapper2 API; no biomapper-ui app code touched.
- **Error propagation:** Per-record pipeline errors are captured and reported, never aborting the batch; missing/unparseable IDs degrade to `None`/`none`, not exceptions.
- **State lifecycle risks:** Paid-API results cached + persisted by default to avoid re-spending on re-runs; timestamped dirs prevent overwrite.
- **API surface parity:** None — no shared interfaces changed.
- **Integration coverage:** Pipeline runner is unit-tested with a mocked client; a real smoke run validates end-to-end wiring.
- **Unchanged invariants:** biomapper-ui frontend, FastAPI backend, and the `biomapper` SDK are untouched.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Confident-but-wrong fuzzy matches (e.g., Glucose → Blood Glucose) inflate apparent disagreement | Report confidence tiers; flag high-confidence disagreements; consider restricting `annotators` after first run (deferred question) |
| Silent ID loss from `list()` on dict / dropping empty `{}` | Use `dict(...)` copy and `is not None` guards (learning #1); tested in Units 2–3 |
| ID format mismatches cause false disagreements | Symmetric per-namespace normalization with explicit tests (Unit 1) |
| Wrong backend / missing API key produces empty or dev-only results | README documents env setup; runner prints target base URL; confirm before trusting (learning #3) |
| Paid API cost on accidental re-runs | Default persistence + simple reload of `outputs/raw/*.json` (Unit 2) |
| Non-unique `feature_id` mis-joins | Join on `(feature_id, matched_name)`; tested in Unit 3 |
| Input files are the unpublished input data | Copy into git-ignored `analysis/ms1-biomapper-concordance/data/`; never commit; document retrieval path |
| Hinted-pass agreement is circular | Name-only is the sole concordance metric; hinted = lift + cross-namespace only (R2, Unit 4) |
| Agreement inflated by promiscuous multi-ID matches | Split exact vs partial; record candidate cardinality (Unit 3) |
| Headline rate hides easy/hard skew | Sized denominator + per-tier stratification (R7, Unit 4) |
| New-coverage presented as validated value | Confidence-tier stratification + sample spot-check, labeled candidate (R8, Unit 4) |
| Non-HMDB hints silently ignored by API | Probe before trusting; scope lift claim to honored namespaces (Unit 2) |
| RefMet master list unavailable / class source missing | Fall back to ID-only RefMet; skip class axis with a noted limitation (Scope) |
| Sized denominator hides the ID-poor half | Print comparable subset as a fraction of all features; state concordance covers only double-annotated rows (Unit 4) |

## Documentation / Operational Notes

- README is the operational doc (setup, run, interpret).
- **Add `.gitignore` entries before implementation** — root `.gitignore` (plus a belt-and-suspenders `analysis/ms1-biomapper-concordance/.gitignore`) must list **both `data/` (the unpublished inputs) and `outputs/` (raw paid-API results + reload cache)** so neither is ever committed. Confirm the repo root `.env` is already git-ignored before pointing the README at it.
- **`comparison.csv` and `report.md` embed the curated reference IDs** — treat them with the same confidentiality as the inputs: share directly with the data owner via the original channel; never post to a shared repo or public storage. (Copy them out; don't commit the outputs dir.)

## Sources & References

- Input files: `~/Downloads/{unique_features_by_best_tier.csv, per_metabolite_annotation.csv, All_Methods_Features.xlsx}` (copy into `analysis/ms1-biomapper-concordance/data/`).
- Biomapper SDK: `../biomapper` (v1.2.1); tutorial `../biomapper/notebooks/biomapper_tutorial.ipynb`.
- Reference setup script: `artifacts/python-api/scripts/verify_api.py`.
- Learnings: `docs/solutions/logic-errors/biomapper-sdk-dict-list-data-loss-2026-05-06.md`, `docs/solutions/logic-errors/preserve-original-columns-and-hint-prefix-fix-2026-05-07.md`, `docs/solutions/developer-experience/biomapper-ui-deploy-cycle-2026-04-23.md`, `docs/solutions/best-practices/csv-formula-injection-prevention-2026-05-23.md`.
