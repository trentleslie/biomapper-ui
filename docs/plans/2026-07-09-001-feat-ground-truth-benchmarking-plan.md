---
title: "feat: Ground-Truth Benchmarking (HMDB-first vertical)"
type: feat
status: active
date: 2026-07-09
origin: docs/brainstorms/2026-07-09-ground-truth-benchmarking-requirements.md
---

# feat: Ground-Truth Benchmarking (HMDB-first vertical)

## Overview

Add an end-to-end benchmarking surface to the BioMapper UI that measures how well
BioMapper resolves names to identifiers against known-correct answers. A curator uploads a
wide-format CSV (name + `gt_<vocab>` columns) or selects a built-in HMDB gold set; the
backend reuses the existing mapping pipeline to produce candidate lists, then a new scoring
service computes per-row `hit_ranks`, categories, corpus metrics (MAP/MRR/Hit@k/Recall),
and diagnostic gaps. Runs persist durably; results render as a corpus metrics table with a
reranking decision matrix, a filterable per-row disagreement log, CSV/JSONL export, a
run-history list, and a minimal two-run comparison.

Slice 1 is an **HMDB-first vertical**: the ingestion format, scorer, and schema support N
vocabularies, but only HMDB is validated and shipped. This replaces the Benchmark tab's
"Coming Soon" placeholder (`artifacts/frontend/src/pages/upload.tsx`).

## Problem Frame

BioMapper has no in-UI way to measure resolution quality against ground truth. The scoring
semantics are fully specified in `biomapper-eval-metrics-design.md` but unimplemented, and
the offline `analysis/ms1-biomapper-concordance/` code is a set-overlap concordance study
(no rank metrics), so it cannot be lifted for the rank-sensitive scorer. Two audiences —
curators (bring-own-data) and internal QA (config tuning, which needs run-to-run
comparison) — are served by one scoring core. See origin:
`docs/brainstorms/2026-07-09-ground-truth-benchmarking-requirements.md`.

## Requirements Trace

- R1. Wide-format GT CSV upload (name + `gt_<vocab>`; `;`-separated; empty = excluded).
- R2. Column-mapping step (map uploaded columns → name + vocabularies).
- R3. GT modeled as a set of IDs per (name, vocabulary); single/multi uniform.
- R4. Curated HMDB gold set derived from `biomapper_ui_test_dataset.csv` (relabel curated
  `provided_ids` → `gt_hmdb`), selectable day-one input.
- R5. Backend scorer: per-vocab normalization, exact→normalized match, canonical
  `hit_ranks`; built fresh (offline code informs normalization only).
- R6. Seven per-row categories + a transport-error bucket outside the seven.
- R7. Reuse mapping pipeline; **merge `identifiers` + `kgEquivalentIds`** per vocab; probe
  confidence-ordering; **forbid/flag `config.hints`**.
- R8. Corpus metrics per (dataset, vocabulary) cell.
- R9. Diagnostic gaps + reranking decision matrix, attached per vocabulary.
- R10. Vocabularies with no GT rendered honestly (empty/omitted, never zeros).
- R11. Per-row review table (filter by category/vocab, sort by rank) + rerankable filter
  preset (`hit_ranks` non-empty AND `0 < hit_ranks[0] < 5`).
- R12. Current view (full log or rerankable preset) exportable as CSV/JSONL.
- R14. Durable run persistence (input names, config, SDK version, metrics, per-row log),
  written before the in-memory job store's 1-hour TTL purge.
- R16. Minimal two-run comparison (pick two runs → metric deltas + mismatch warnings).

## Scope Boundaries

- Full multi-vocabulary surface — **additive**; only HMDB validated/shipped in slice 1.
- Positives-only scoring — empty GT cells excluded; no true-negative detection.
- LLM reranker construction, calibration metrics, cross-vocabulary reconciliation, fuzzy
  name matching, inline curator flag/correct actions — all out of scope (see origin).

### Deferred to Separate Tasks

- Higher-reliability (MS2-adjudicated / non-HMDB) gold set — scheduled next unit of work.
- Full cross-config comparison framework (trend charts, N-way matrices, config sweeps) —
  separate "benchmarking process" design doc. Slice 1 ships only the two-run delta.
- Frontend automated test harness — none exists today (no vitest/RTL). Adding one is a
  separate infra task (requires a catalog dep under the repo's `minimumReleaseAge` rule);
  this plan concentrates correctness logic in the pytest-covered backend and verifies
  frontend units via `tsc -b` + manual `/run`.

## Context & Research

### Relevant Code and Patterns

- **Mapping pipeline to reuse:** `artifacts/python-api/services/mapper.py` —
  `MapperService.map_batch` (async iterator, `MAX_CONCURRENCY=10`), `_process_result`
  (result shape: `identifiers` keys `hmdb/chebi/pubchem/refmet/lipidmaps/kegg/...` via
  `result.ids_for()`, `kgEquivalentIds` stored separately, `confidenceScore`). The hints
  path (`_map_with_retry`, `config.hints` → `map_entity(identifiers=...)`) is the leak to
  forbid.
- **Route/job/DB triad to mirror:** `artifacts/python-api/routes/map.py`
  (`/map/batch` + BackgroundTask `_run_mapping`, SSE `/map/stream/{id}`, `/map/result/{id}`,
  `_sse_event`), `artifacts/python-api/routes/jobs.py` (run-history + user-scoped
  get/delete), `artifacts/python-api/services/jobs.py` (`JobStore`, `_TTL_SECONDS=3600`,
  persist-on-complete), `artifacts/python-api/services/database.py` (`Database`, WAL,
  `CREATE TABLE IF NOT EXISTS`, JSON-TEXT serialization, `initialize`, CRUD helpers,
  `recover_stale_jobs`), `artifacts/python-api/main.py` (lifespan DB init, router include).
- **Normalization to port (not lift):** `analysis/ms1-biomapper-concordance/io_and_normalize.py`
  — `normalize_id(namespace, value)` (matches the design's contract), and
  `biomapper_ids(result, namespace)` which **unions `identifiers` + `kg_equivalent_ids`**
  per vocab (the exact merge R7 needs). Discard `compare.py` set-overlap classification.
- **Frontend:** `artifacts/frontend/src/pages/upload.tsx` (Benchmark tab stub ~L458–482;
  `Papa.parse`/`XLSX`, `react-dropzone`, value-based prefix detection `inferPrefix`,
  `extractNamesFromRows` dedup), `artifacts/frontend/src/pages/dashboard.tsx` (shadcn
  `Table` + manual sort + `PAGE_SIZE=25` pagination + expand rows; `buildEnrichedDownload`,
  `handleDownloadCSV/JSON/TSV`), `artifacts/frontend/src/pages/flagged.tsx`
  (`escapeCsvField`, list/empty/error states), `artifacts/frontend/src/hooks/use-mapping-stream.ts`
  (native `EventSource` SSE consumer), `artifacts/frontend/src/App.tsx` +
  `components/AppShell.tsx` (wouter routes + nav).
- **Codegen + proxy wiring:** `lib/api-spec/openapi.yaml` (hand-written) →
  `lib/api-spec/orval.config.ts` → generated `lib/api-client-react`;
  `artifacts/api-server/src/app.ts` (Express `/api/*` proxy mounts with `requireMapAuth` +
  `onProxyReqInjectUser`).

### Institutional Learnings

- `docs/solutions/runtime-errors/fastapi-union-return-type-crash-2026-05-17.md` — never
  annotate a route `-> dict | JSONResponse`; use `response_model=None`. Smoke-test imports.
- `docs/solutions/logic-errors/biomapper-sdk-dict-list-data-loss-2026-05-06.md` — no
  serialization middleware; the Python dict key **is** the JSON key → emit camelCase from
  commit one; populate every response field on every branch (error/skip/retry); use
  `is not None` for collections; after codegen run `tsc -b` in `lib/api-client-react/`.
- `docs/solutions/build-errors/orval-generated-files-not-committed-2026-05-23.md` — after
  codegen, `git status` + `git add` **new untracked** generated files (`clean:true`
  regenerates barrels; missing files break CI).
- `docs/solutions/best-practices/optimistic-ui-sync-and-atomic-cap-enforcement-2026-05-18.md`
  — `setQueryData` in `onSuccess`; guard server→local sync effects with an `isMutating`
  flag; collapse check-then-act into a single atomic SQL statement.
- `docs/solutions/best-practices/csv-formula-injection-prevention-2026-05-23.md` — reuse
  `escapeCsvField()` (tab-prefix `= + - @`); RFC-4180 quoting alone is insufficient.
- `docs/solutions/logic-errors/preserve-original-columns-and-hint-prefix-fix-2026-05-07.md`
  — persist uploaded rows to IndexedDB (`idb-keyval`) keyed by run id **before** dispatch
  (the upload page unmounts on route change); value-based prefix detection.
- `docs/solutions/logic-errors/react-useeffect-unstable-array-ref-infinite-loop-2026-05-23.md`
  — use stable `query.data` in effect deps, never `query.data ?? []`.
- `docs/solutions/security-issues/feedback-endpoint-auth-pii-hardening.md` — auth new
  endpoints by default (`x-clerk-user-id`); every `SELECT` gets a bounded `LIMIT`
  (`Query(100, ge=1, le=1000)`); `hmac.compare_digest` for any API-key compare.
- `docs/solutions/developer-experience/biomapper-ui-deploy-cycle-2026-04-23.md` — SSE needs
  `proxy_buffering off` + long read timeout; use ground-truth fixtures for verification.

## Key Technical Decisions

- **Mirror the map router/job/DB triad for benchmark** rather than inventing new
  orchestration: `routes/benchmark.py`, `services/scorer.py`, and new tables in
  `services/database.py`. Lowest-risk path; inherits SSE/progress and user-scoping.
- **Scoring is a server-side continuation** chained inside the mapping BackgroundTask after
  `job_store.complete`, writing `benchmark_runs` + `benchmark_row_logs` synchronously before
  the run is marked terminal. Rationale: scoring output has no persistence path today and
  the in-memory job store purges at 1 hour; a client-triggered score would also orphan on
  navigate-away. (Resolves flow-analysis C2, I6.)
- **Forbid hints on benchmark runs**: the dispatch strips `hints`/`hint_columns`, and the
  API rejects any benchmark request with non-empty `config.hints` (defense in depth — the
  mapper honors hints regardless of UI). The persisted run records `hints_stripped: true`.
  Rationale: the Benchmark tab sits on `upload.tsx`, whose default path feeds ID columns as
  hints → Hit@1 = 100% by construction. (Resolves C1.)
- **Merge `identifiers` + `kgEquivalentIds` per vocabulary** into one candidate list before
  scoring (HMDB frequently arrives only via `kgEquivalentIds`); the per-row log shows the
  merged `returned_ids`. (Resolves I4.)
- **Confidence-ordering is probed per vocabulary and stored per run**; when ordering is
  unverified for a vocab, rank-sensitive cells (MAP, MRR, Hit@1/5, ranking gap, reranking
  headroom, rerankable preset) render **suppressed/flagged**, while order-insensitive
  Hit@∞ / Recall still show. (Resolves C3.)
- **Transport failures ≠ resolution misses**: per-name errors
  (`aborted/auth_failure/config_error/mapping_error`) go to a `RUN_ERROR` bucket excluded
  from denominators; a mapping job that ends in `error` status yields a run marked
  `partial/invalid`, not scored as all-miss. (Resolves C4.)
- **Duplicate-name GT merge**: union non-empty GT across identical names; a name is
  `GROUND_TRUTH_EMPTY` only if all its rows are empty. Surface an "N names merged" notice.
  (Resolves I1.)
- **Malformed detection lives in the scorer**, applying the design's `normalize_id`
  `ValueError` contract; the client CSV parser preserves raw cells (no silent
  normalize/drop). (Resolves I3.)
- **camelCase response fields from commit one**; mixed-return routes use
  `response_model=None`; new endpoints auth-gated by `x-clerk-user-id`; bounded `LIMIT` on
  per-row-log reads.
- **Dedicated benchmark frontend flow**, not a reuse of `upload.tsx`'s hinted submit path;
  uploaded rows persisted to IndexedDB before dispatch; SSE via a native-`EventSource` hook
  mirroring `use-mapping-stream.ts`.
- **SDK/env capture**: record `importlib.metadata.version("biomapper")` (already read in
  `main.py`) and the resolved BioMapper env/base_url per run; default `"unknown"`, never
  null. (Resolves M1.)

## Open Questions

### Resolved During Planning

- Client-triggered vs. server-side scoring → **server-side chained** (persistence + orphan
  safety).
- Hints on benchmark runs → **stripped + API-rejected**.
- Unverified ordering → **suppress rank-sensitive cells**, show order-insensitive metrics.
- Transport failure vs. `RETURNED_EMPTY` → **separate `RUN_ERROR` bucket**, error-status
  run marked partial/invalid.
- Duplicate names with divergent GT → **union non-empty GT**, merge notice.
- Reuse offline scorer? → **port normalization + `identifiers`+`kgEquivalentIds` merge
  only**; build `hit_ranks` scorer fresh.

### Deferred to Implementation

- Exact ordering-probe heuristic (compare `confidenceScore` monotonicity vs. list order
  across a sample; threshold for "verified"). Depends on seeing real SDK output.
- Final aiosqlite column names/indexes for the two new tables.
- Whether the merged candidate list's ordering (kgEquivalent items carry no confidence) is
  "verified" — likely treated as unverified whenever kgEquivalent contributes.
- Per-row-log pagination threshold (match `dashboard.tsx` `PAGE_SIZE`; revisit if >1000).
- Exact installed `biomapper` version and whether `ids_for()` is confidence-ordered — the
  U1 probe answers this at implementation time.

## Output Structure

    artifacts/python-api/
      services/
        scorer.py                  # NEW: hit_ranks scorer, categories, metrics, diagnostics
        benchmark_normalize.py     # NEW: ported normalize_id + merged candidate assembly
        benchmark_store.py         # NEW: benchmark run orchestration + durable persistence
        sdk_meta.py                # NEW: SDK version/env capture + ordering-trust policy
      routes/
        benchmark.py               # NEW: /benchmark batch|stream|result|runs|compare
      models/
        benchmark_schemas.py       # NEW: request/response/persistence schemas
      tests/
        test_scorer.py             # NEW
        test_benchmark_normalize.py# NEW
        test_benchmark_store.py    # NEW
        test_benchmark_routes.py   # NEW
      data/
        hmdb_gold_set.csv          # NEW: curated wide-format gold set (committed snapshot)
        hmdb_gold_expectation.json # NEW: hand-scored hit_ranks expectation fixture
    artifacts/frontend/src/
      pages/
        benchmark.tsx              # NEW: upload + column-mapping + gold-set + run progress
        benchmark-results.tsx      # NEW: corpus table + diagnostics + per-row review + export
        benchmark-runs.tsx         # NEW: run-history list + two-run comparison
      hooks/
        use-benchmark-stream.ts    # NEW: native EventSource SSE consumer
    lib/api-spec/openapi.yaml       # MODIFY: add /benchmark paths + schemas
    artifacts/api-server/src/app.ts # MODIFY: /api/benchmark proxy mount + auth

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not
> implementation specification. The implementing agent should treat it as context, not code
> to reproduce.*

```
                 ┌─────────────────────────── frontend ───────────────────────────┐
 benchmark.tsx ──POST /api/benchmark/batch──▶  (Express proxy, requireMapAuth,
   (upload+map, gold-set,                        inject X-Clerk-User-Id)
    hints STRIPPED, rows→IndexedDB)                         │
        │  EventSource /api/benchmark/stream/{id}           ▼
        │◀────────── progress ─────────  routes/benchmark.py  ──create run──▶ job_store
        ▼                                        │
 benchmark-results.tsx                    BackgroundTask:
   corpus table + decision matrix           1. reject if config.hints non-empty
   rank cells SUPPRESSED if ordering          2. mapper.map_batch(names, hint-free cfg)
   unverified; per-row log + presets;         3. ordering_probe per vocab
   CSV/JSONL export                           4. scorer.score(results, ground_truth)
 benchmark-runs.tsx                           5. persist benchmark_runs + row_logs  ◀── durable
   history list + two-run delta                   (BEFORE marking terminal)         (database.py)
   (warn on dataset/SDK/config mismatch)      6. job_store.complete

 scorer.score():  per (name,vocab): merge identifiers+kgEquivalentIds → normalize →
   exact→normalized match → hit_ranks (positions) → category (7 + RUN_ERROR) →
   corpus MAP/MRR/Hit@k/Recall + diagnostic gaps + decision-matrix label per vocab
```

## Implementation Units

### Phase A — Foundations & Verification

- [ ] **Unit 1: SDK/env capture + ordering-trust policy** *(Checkpoint-2 decision: trust SDK order by version contract; no runtime probe)*

**Goal:** Capture the biomapper SDK version + resolved env per run, and establish the
ordering-trust policy: `ids_for()` list order is treated as the SDK's asserted
confidence order (per `biomapper-eval-metrics-design.md` L34), gated on the captured SDK
version. Rank metrics are computed and labeled "SDK-asserted order, not independently
verified." No runtime probe (it is impossible — no per-candidate confidence exists).
Items contributed only by `kgEquivalentIds` (unscored) are appended after `identifiers`
items so they never occupy trusted high ranks.

**Requirements:** R7, R14 (partial)

**Dependencies:** None

**Files:**
- Create: `artifacts/python-api/services/sdk_meta.py`
- Test: `artifacts/python-api/tests/test_sdk_meta.py`

**Approach:**
- Capture SDK version via `importlib.metadata.version("biomapper")` (as `main.py` already
  does) and the resolved env/base_url from `services/env_routing.py`; default `"unknown"`,
  never null. These become fields on every persisted run (reproducibility + comparison
  mismatch checks).
- Define the ordering-trust policy: expose an `order_asserted` flag (true when the captured
  SDK version is within a known-good range; the design doc asserts `ids_for()` is internally
  confidence-ordered) that the scorer/frontend use to label — not suppress — rank metrics.
  No runtime probe: there is no per-candidate confidence to probe against.

**Patterns to follow:** version read in `artifacts/python-api/main.py`; env resolution in
`artifacts/python-api/services/env_routing.py`.

**Test scenarios:**
- Happy path: known biomapper version + env → correct `{sdk_version, env, order_asserted}` tuple.
- Edge case: biomapper metadata missing → `sdk_version = "unknown"`, `order_asserted = false`,
  no exception.
- Edge case: dev vs production env resolves distinct base_urls (feeds the comparison mismatch check).

**Verification:** Every run record carries `{sdk_version, env, order_asserted}`; rank metrics
are labeled (not suppressed) per the policy.

- [ ] **Unit 2: Curated HMDB gold set + hand-scored expectation fixture**

**Goal:** Produce a committed wide-format HMDB gold set derived from
`biomapper_ui_test_dataset.csv`, plus a small hand-scored `hit_ranks` expectation used to
verify the scorer.

**Requirements:** R4

**Dependencies:** None

**Files:**
- Create: `artifacts/python-api/data/hmdb_gold_set.csv` (columns `name, gt_hmdb`)
- Create: `artifacts/python-api/data/hmdb_gold_expectation.json` (hand-scored subset)
- Test: covered via `test_scorer.py` (Unit 4) consuming the fixture

**Approach:**
- **Review correction (RC-3):** parse with a quote-aware CSV reader (not naive comma-split —
  several `compound_name` values contain commas/quotes and will mis-split). The name column is
  `compound_name` (not `name`); map it to `name`. Filter `provided_ids` to values matching
  `HMDB\d+` before relabeling to `gt_hmdb` (raw column also contains `MS2`/`CURATION` tokens
  from mis-split rows). Pin as a committed snapshot (do not live-read the source CSV).
- **Tier by `match_level` (RC-3, per project reliability reframe):** of the ~31 populated
  rows, ~15 are `CURATION` and ~12 are `MS2`. Embedded/MS2 HMDB is the least-reliable, near-
  circular oracle. Do **not** report one uniform HMDB number over mixed provenance: make the
  **CURATION subset the headline** gold set and keep `MS2` as a separately-labeled subset.
  Record `match_level` per row. (Confirm exact counts at build time.)
- Hand-score a small subset (known `hit_ranks`/Hit@1) so the success criterion is CI-enforceable.

**Test scenarios:** `Test expectation: none — static data fixture; correctness is asserted by
Unit 4's scorer tests that consume it.`

**Verification:** `hmdb_gold_set.csv` conforms to R1; the expectation fixture is consumed by
scorer tests and passes.

### Phase B — Scoring Core

- [ ] **Unit 3: Per-vocab normalization + merged candidate assembly**

**Goal:** A tested pure module that normalizes IDs per vocabulary and assembles the merged
(`identifiers` + `kgEquivalentIds`) candidate list per (name, vocabulary).

**Requirements:** R5, R7

**Dependencies:** None

**Files:**
- Create: `artifacts/python-api/services/benchmark_normalize.py`
- Test: `artifacts/python-api/tests/test_benchmark_normalize.py`

**Approach:**
- Port `normalize_id` rules from `analysis/ms1-biomapper-concordance/io_and_normalize.py`
  (HMDB zero-pad, ChEBI bare digits, LIPIDMAPS `LM` prefix, PubChem int, RefMet name
  canonicalization, UniProt/Ensembl uppercase). Malformed → `ValueError` per design.
- **Review correction (RC-2):** do NOT port `biomapper_ids` — it returns an unordered
  `set[str]` and would destroy the ranks `hit_ranks` depends on. Reimplement the merge as an
  **order-preserving de-dup over lists**: iterate `identifiers[key]` then `kgEquivalentIds[key]`
  in order, normalize each, keep first occurrence, tag source (`identifiers` = confidence-
  ordered, `kg` = unscored). Reuse only the scalar `normalize_id` from the reference, not the
  set-valued `biomapper_ids`/`normalize_ids`.

**Execution note:** Port test-first — mirror the offline module's known input/outputs, then
extend with malformed cases.

**Patterns to follow:** `analysis/ms1-biomapper-concordance/io_and_normalize.py`
(`normalize_id`, `biomapper_ids`, `NAMESPACE_SOURCE_KEYS`, LipidMaps `LM` quirk).

**Test scenarios:**
- Happy path: `HMDB294`→`HMDB0000294`; `chebi:17234`/`17234`→canonical; `LM...`→uppercase+`LM`.
- Edge case: HMDB present only in `kgEquivalentIds` → appears in merged list.
- Edge case: duplicate ID across both sources → de-duplicated once, order preserved.
- Error path: malformed ID (`HMDB`, empty, `;;`) → `ValueError` surfaced as MALFORMED later.
- Edge case: RefMet name normalization (whitespace/case) — flagged as name-based matching.

**Verification:** Given a mapper result dict, the module returns a normalized merged
candidate list per vocab with source tags; malformed inputs raise.

- [ ] **Unit 4: Scorer — hit_ranks, categories, corpus metrics, diagnostics**

**Goal:** The scoring core: per-row `hit_ranks` and category, corpus metrics per
(dataset, vocabulary), diagnostic gaps, and per-vocab decision-matrix label.

**Requirements:** R5, R6, R8, R9

**Dependencies:** Unit 2 (fixture), Unit 3 (normalize/merge)

**Files:**
- Create: `artifacts/python-api/services/scorer.py`
- Test: `artifacts/python-api/tests/test_scorer.py`

**Approach:**
- Per (name, vocab): normalize GT set + merged candidate list; exact-match fast path then
  normalized; `hit_ranks` = sorted positions of GT items in the candidate list; category ∈
  {EXACT_MATCH, NORMALIZED_MATCH, NO_OVERLAP, GROUND_TRUTH_EMPTY, RETURNED_EMPTY,
  MALFORMED_GROUND_TRUTH, MALFORMED_RETURNED} plus RUN_ERROR (transport failures, excluded).
- Corpus per cell: n, MAP, MRR, Hit@1/5/∞, Mean Recall@5, Mean candidates, normalization
  lift. Diagnostic gaps: ranking gap, reranking headroom, recall headroom, norm lift.
- Attach a decision-matrix label per vocab (SHIP / RERANK / ADD ANNOTATORS / FIX UPSTREAM)
  from the design's thresholds. Emit an `ordering_verified` flag per vocab (from Unit 1) so
  the frontend can suppress rank cells.
- GROUND_TRUTH_EMPTY and RUN_ERROR excluded from denominators (positives-only).

**Execution note:** Test-first against `hmdb_gold_expectation.json` (Unit 2) — assert exact
`hit_ranks`/Hit@1/MAP for the hand-scored subset before extending to edge categories.

**Patterns to follow:** metric definitions in `biomapper-eval-metrics-design.md`
(Per-row / Corpus / Diagnostic sections); groupby-by-cell shape in
`analysis/ms1-biomapper-concordance/report.py::aggregate` (structure only, not counts).

**Test scenarios:**
- Happy path: hand-scored gold subset reproduces exact `hit_ranks`, Hit@1, MAP, MRR.
- Category coverage: one row exercising each of the 7 categories + RUN_ERROR.
- Edge case: multi-item GT (`|GT|>1`) → Recall@k and Hit@k differ correctly; AP over ranks.
- Edge case: HMDB hit only via `kgEquivalentIds` (merged) → scores as a match, not miss.
- Edge case: single-item GT collapses (Hit@k≡Recall@k, AP≡RR).
- Edge case: normalization-only match → NORMALIZED_MATCH, contributes to norm lift.
- Edge case: empty GT excluded from denominator; RUN_ERROR excluded from denominator.
- Edge case: `ordering_verified=false` vocab → rank-sensitive fields flagged, Hit@∞/Recall present.
- Edge case: mean-candidates guardrail computed; empty vocab omitted (not zeroed).

**Verification:** Scorer output matches the expectation fixture and the design's example
semantics; all categories reachable; suppression flag present per vocab.

### Phase C — Orchestration & Persistence

- [ ] **Unit 5: Persistence — benchmark_runs + benchmark_row_logs tables + CRUD**

**Goal:** Durable storage for runs and per-row logs, extending the existing aiosqlite layer.

**Requirements:** R14

**Dependencies:** None (schema); consumed by Unit 6

**Files:**
- Modify: `artifacts/python-api/services/database.py`
- Test: `artifacts/python-api/tests/test_benchmark_store.py` (schema/CRUD portion)

**Approach:**
- In `initialize()`, add `CREATE TABLE IF NOT EXISTS benchmark_runs` (run_id PK, user_id,
  display_name, dataset_name, status, config TEXT/JSON incl. `hints_stripped`, sdk_version,
  env, input_names TEXT/JSON, corpus_metrics TEXT/JSON, ordering_verdicts TEXT/JSON,
  created_at, updated_at) and `benchmark_row_logs` (run_id FK, name, vocabulary,
  ground_truth TEXT, returned_ids TEXT, hit_ranks TEXT, category) with indexes
  `idx_bench_user_created` and `idx_bench_rowlog_run`.
- CRUD helpers mirroring existing ones: `insert_benchmark_run`, `update_benchmark_run`,
  `get_benchmark_run`, `list_benchmark_runs` (LIMIT, user-scoped, ORDER BY created_at DESC),
  `insert_row_logs` (batch), `get_row_logs` (bounded LIMIT), `delete_benchmark_run`.
- Follow JSON-TEXT serialization; auto-JSON the dict/list fields as `update_job` does.

**Patterns to follow:** `artifacts/python-api/services/database.py` (`jobs`/`flagged_names`
table creation, `_row_to_dict`, allowed-field whitelist, `recover_stale_jobs`).

**Test scenarios:**
- Happy path: insert a run + row logs, read back with JSON round-trip intact.
- Edge case: `list_benchmark_runs` respects LIMIT and user scoping; DESC order.
- Edge case: empty collections stored/read via `is not None` (not truthiness).
- Integration: `initialize()` on a fresh DB creates both tables + indexes idempotently.
- Error path: `get`/`delete` of unknown run_id returns None/no-op, not an exception.

**Verification:** Fresh-DB init creates the tables; runs and logs persist and round-trip.

- [ ] **Unit 6: Benchmark orchestration + API surface + codegen + proxy**

**Goal:** Wire the full backend flow: dispatch (hint-stripped), reuse mapping, server-side
chained scoring, durable persistence before terminal, SSE progress, result/history/compare
endpoints, generated client types, and the Express proxy mount.

**Requirements:** R7, R11 (rerankable filter server option), R14, R16

**Dependencies:** Units 1, 3, 4, 5

**Files:**
- Create: `artifacts/python-api/routes/benchmark.py`,
  `artifacts/python-api/services/benchmark_store.py`,
  `artifacts/python-api/models/benchmark_schemas.py`
- Modify: `artifacts/python-api/main.py` (include router), `lib/api-spec/openapi.yaml`
  (paths + schemas), `artifacts/api-server/src/app.ts` (`/api/benchmark` proxy + auth)
- Test: `artifacts/python-api/tests/test_benchmark_routes.py`

**Approach:**
- `POST /benchmark/batch`: accept names + ground_truth + config + dataset_name; **reject 400
  if `config.hints` non-empty**, else strip `hints`/`hint_columns` and set
  `hints_stripped=true`. Create run + job, BackgroundTask runs `mapper.map_batch`, then
  `ordering_probe`, then `scorer.score`, then persist run+row_logs, then mark terminal.
- SSE `/benchmark/stream/{run_id}` mirrors `_sse_event`; stages: mapping N/M → scoring →
  complete. `GET /benchmark/result/{run_id}` returns metrics + ordering verdicts (202 if not
  done). `GET /benchmark/runs` (history, user-scoped, LIMIT), `GET /benchmark/runs/{id}`,
  `DELETE /benchmark/runs/{id}`, `GET /benchmark/runs/{id}/rows` (bounded LIMIT + optional
  `category`/`vocabulary`/`rerankable` filter), `GET /benchmark/compare?a=&b=` (returns both
  runs' metrics + a `mismatch` object flagging dataset/SDK/config differences).
- Routes use `response_model=None` where returns are mixed; camelCase fields; auth via
  `x-clerk-user-id`. After editing `openapi.yaml`: run orval codegen, `git add` new
  generated files, `tsc -b` in `lib/api-client-react/`.

**Execution note:** Start with a failing integration test asserting a hinted benchmark
request is rejected 400, and that a purge of the in-memory store still returns full results.

**Patterns to follow:** `artifacts/python-api/routes/map.py` (batch + SSE + BackgroundTask),
`artifacts/python-api/routes/jobs.py` (user-scoped history/delete),
`artifacts/api-server/src/app.ts` (`/api/map` mount → copy for `/api/benchmark`).

**Test scenarios:**
- Error path: `config.hints` non-empty → 400; stripped config recorded on the run.
- Integration: full run (mocked mapper via `conftest.py` biomapper mock) → persisted metrics
  + row logs; `purge_expired()` then `GET /benchmark/result` still returns full data (C2).
- Integration: mapping job ends `error` → run marked partial/invalid, not scored all-miss (C4).
- Edge case: transport-error names land in RUN_ERROR bucket, excluded from denominators.
- Edge case: `/rows` respects LIMIT + `category`/`vocabulary`/`rerankable` filters.
- Edge case: `/compare` flags dataset/SDK/config mismatch between two runs (I5).
- Security: endpoints reject missing/mismatched `x-clerk-user-id`.
- Import smoke: `python -c "from routes.benchmark import router"` (union-return guard).

**Verification:** A benchmark run completes end-to-end against the mocked SDK, persists
durably, survives a store purge, and all endpoints enforce auth + bounds.

### Phase D — Frontend

- [ ] **Unit 7: Benchmark upload + column-mapping + gold-set selector + run progress**

**Goal:** The benchmark entry flow replacing the "Coming Soon" placeholder: upload wide CSV,
map columns, or pick the built-in gold set; dispatch a hint-free run; show staged progress.

**Requirements:** R1, R2, R4, R10 (empty-vocab honesty starts here)

**Dependencies:** Unit 6 (endpoints + generated hooks)

**Files:**
- Create: `artifacts/frontend/src/pages/benchmark.tsx`,
  `artifacts/frontend/src/hooks/use-benchmark-stream.ts`
- Modify: `artifacts/frontend/src/App.tsx` (route), `artifacts/frontend/src/components/AppShell.tsx`
  (nav), `artifacts/frontend/src/pages/upload.tsx` (link Benchmark tab → new page or remove stub)
- Test: manual (`/run`) + `tsc -b` — see Deferred to Separate Tasks (no FE harness)

**Approach:**
- Reuse `Papa.parse`/`XLSX`/`react-dropzone` and value-based prefix detection; column-mapping
  UI: per-detected-column role dropdown (Name / `gt_<vocab>` / Ignore), auto-detect
  `gt_hmdb`/`HMDB\d+`, first-rows preview, inline validation.
- **No hint columns** — the ID-column picker is replaced by GT columns; show a visible
  "hints disabled for benchmark integrity" affordance.
- Persist uploaded rows to IndexedDB (`idb-keyval`) keyed by run id **before** dispatch.
- Built-in gold-set option skips upload/mapping. Progress via `use-benchmark-stream.ts`
  (native `EventSource`) showing mapping N/M → scoring → complete.

**Patterns to follow:** `artifacts/frontend/src/pages/upload.tsx` (parse/dropzone/prefix),
`artifacts/frontend/src/hooks/use-mapping-stream.ts` (EventSource), IndexedDB pattern from
`docs/solutions/logic-errors/preserve-original-columns-and-hint-prefix-fix-2026-05-07.md`.

**Test scenarios:** *(feature-bearing UI; described for manual verification + future harness)*
- Happy path: upload valid CSV → auto-detected mapping → dispatch → progress → redirect to results.
- Error path: non-CSV/unparseable → inline error before mapping.
- Error path: zero `gt_<vocab>` columns mapped → dispatch blocked with message.
- Error path: same column mapped to name and a vocab → hard error; two columns → same vocab → warn + merge.
- Edge case: duplicate names with divergent GT → "N names merged" notice.
- Edge case: built-in gold set → runs with no upload/mapping.
- Integration: rows persisted to IndexedDB before navigation (survive unmount).

**Verification:** A curator can dispatch a hint-free benchmark from upload or the gold set and
watch staged progress; invalid mappings are blocked with clear messaging.

- [ ] **Unit 8: Results — corpus metrics table, diagnostics, per-row review, export**

**Goal:** The results surface: corpus metrics table with per-vocab decision-matrix labels and
rank-cell suppression, plus the filterable per-row disagreement log with the rerankable
preset and CSV/JSONL export.

**Requirements:** R8, R9, R10, R11, R12

**Dependencies:** Unit 6

**Files:**
- Create: `artifacts/frontend/src/pages/benchmark-results.tsx`
- Modify: `artifacts/frontend/src/App.tsx` (route)
- Test: manual (`/run`) + `tsc -b`

**Approach:**
- Corpus table: shadcn `Table`, vocab rows, metric columns; primary metrics (Hit@1, MAP)
  prominent, diagnostics grouped/expandable to avoid a uniform many-cell grid. Per-vocab
  decision-matrix **badge** (SHIP/RERANK/ADD ANNOTATORS/FIX UPSTREAM) with a tooltip showing
  the triggering gap values.
- When `orderingVerified=false` for a vocab, render rank-sensitive cells as a "—/ordering
  unverified" state (not zeros); Hit@∞/Recall still show. Empty-GT vocabs omitted/"—".
- Per-row table: shadcn `Table` + manual pagination (`PAGE_SIZE` like `dashboard.tsx`);
  filter by category + vocabulary, sort by rank; a "Rerankable rows" preset toggle. Export
  buttons reuse `buildEnrichedDownload` + `escapeCsvField`; add a JSONL helper
  (`rows.map(JSON.stringify).join("\n")`) exporting the current view.
- Use stable `query.data` in effect deps (avoid `?? []`).

**Patterns to follow:** `artifacts/frontend/src/pages/dashboard.tsx` (Table + pagination +
download helpers), `artifacts/frontend/src/pages/flagged.tsx` (`escapeCsvField`, states).

**Test scenarios:** *(manual verification + future harness)*
- Happy path: gold-set run renders corpus metrics matching the backend expectation.
- Edge case: unverified-ordering vocab → rank cells suppressed, Hit@∞/Recall shown.
- Edge case: empty-GT vocab → omitted/"—", never `0.0`.
- Happy path: filter by category/vocab, sort by rank; rerankable preset shows only
  `0<hit_ranks[0]<5` rows.
- Happy path: CSV export is formula-injection-safe; JSONL export matches the design log
  format; export reflects the current filtered view.
- Edge case: MALFORMED rows visually distinct with the offending value visible.

**Verification:** Results faithfully render metrics + diagnostics with correct suppression and
empty-cell honesty; per-row log filters/sorts/exports correctly.

- [ ] **Unit 9: Run-history list + two-run comparison**

**Goal:** A history list to reopen persisted runs and a minimal two-run comparison showing
metric deltas with mismatch warnings.

**Requirements:** R14 (reopen), R16

**Dependencies:** Unit 6

**Files:**
- Create: `artifacts/frontend/src/pages/benchmark-runs.tsx`
- Modify: `artifacts/frontend/src/App.tsx` (route), `artifacts/frontend/src/components/AppShell.tsx`
  (nav entry)
- Test: manual (`/run`) + `tsc -b`

**Approach:**
- History list (shadcn Table): timestamp, dataset name, n, headline Hit@1/MAP, SDK version;
  loading/empty/error states like `flagged.tsx`; row → open results; delete action.
- Comparison: select two runs → side-by-side corpus metrics + per-vocab diagnostic gaps with
  deltas; prominently **warn/annotate** when datasets, SDK versions, configs, or
  ordering-verdicts differ (an apples-to-oranges delta reads as a fake config win).

**Patterns to follow:** `artifacts/frontend/src/pages/flagged.tsx` (list/empty/error),
`artifacts/python-api/routes/jobs.py` history semantics (via generated hooks).

**Test scenarios:** *(manual verification + future harness)*
- Happy path: history lists persisted runs newest-first; row opens results; delete removes it.
- Happy path: compare two same-dataset runs → correct metric deltas.
- Edge case: compare runs on different datasets / SDK versions → prominent mismatch warning.
- Edge case: empty history → empty state, not error.

**Verification:** Past runs reopen from persistence; two-run comparison shows deltas and loudly
flags incompatible comparisons.

## System-Wide Impact

- **Interaction graph:** new `routes/benchmark.py` reuses `MapperService.map_batch` and the
  `JobStore`/BackgroundTask machinery; new Express `/api/benchmark` proxy mount; new wouter
  routes + nav entries; generated orval hooks (except SSE, hand-rolled).
- **Error propagation:** per-name transport errors → RUN_ERROR bucket (excluded); mapping job
  `error` → run partial/invalid; API global handlers convert `ValueError`/validation → 400.
- **State lifecycle risks:** scoring must persist to durable tables **before** the run is
  marked terminal (in-memory store purges at 1h); IndexedDB rows persisted before navigation;
  atomic single-statement writes for any capped inserts.
- **API surface parity:** benchmark endpoints follow the map/jobs auth + `x-clerk-user-id` +
  env-header conventions; camelCase fields; `response_model=None` on mixed returns.
- **Integration coverage:** purge-then-reopen returns full data; hinted request rejected;
  `kgEquivalentIds`-only HMDB hit scores as match; auth-aborted partial run not scored all-miss
  — all covered by backend integration tests (mocked SDK via `conftest.py`).
- **Unchanged invariants:** the existing `/map`, `/jobs`, `/flags` surfaces and the `jobs`
  table are untouched; benchmarking adds new tables/routes and never mutates mapping behavior.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `ids_for()` is not confidence-ordered → rank metrics wrong | Unit 1 probe gates rank cells; unverified vocabs render suppressed, not computed (C3). |
| Hints leak GT into the mapper → inflated Hit@1 | Strip client-side + reject at API + record `hints_stripped`; test asserts 400 (C1). |
| Scoring output lost to 1-hour job-store purge | Server-side chained scoring persists to durable tables before terminal; purge-then-reopen test (C2). |
| Server restart mid-run orphans the benchmark run (recover_stale_jobs sweeps only `jobs`) | Insert run row at dispatch + add `recover_stale_benchmark_runs` to lifespan sweep (RC-4). |
| Ordering probe is vacuous — no per-candidate confidence exists → all rank metrics suppressed | Drop the probe; trust `ids_for()` order by SDK-version contract, label metrics "SDK-asserted" (RC-1; Checkpoint-2 decision). |
| `/compare` cross-user data exposure (IDOR) | Enforce per-run ownership on both A and B, 404 on mismatch (RC-9). |
| HMDB scored ~zero because IDs live in `kgEquivalentIds` | Merge both sources per vocab in Unit 3; test the kgEquivalent-only hit (I4). |
| Partial/auth-aborted mapping scored as all-miss | RUN_ERROR bucket + partial/invalid run marking; test (C4). |
| Installed biomapper version/ordering unknown (req says ≥1.2.1, replit says 1.0.1) | Unit 1 captures actual version + probes ordering at implementation time. |
| No frontend test harness → FE regressions uncaught | Concentrate correctness in backend pytest; verify FE via `tsc -b` + manual `/run`; FE harness is a separate task. |
| Orval new files uncommitted / `tsc -b` skipped → CI break | Bake codegen → `git add` new files → `tsc -b` into Unit 6 checklist. |
| SSE buffered by proxy → progress stalls | Reuse the map SSE proxy config (`proxy_buffering off`, long read timeout). |

## Documentation / Operational Notes

- New endpoints require the Express `/api/benchmark` proxy mount + `requireMapAuth`; a missing
  mount 404s from the browser.
- Persist expensive-run artifacts by default (repo SOP): every benchmark run stored durably
  with pinned inputs (names, config, SDK version, env) and a timestamped record.
- Codegen sequence for Unit 6: edit `lib/api-spec/openapi.yaml` → `pnpm --filter
  @workspace/api-spec run codegen` → `git add` generated dirs (incl. new files) → `tsc -b` in
  `lib/api-client-react/`.
- Branch/PR workflow: feature → dev (Greptile) → main; never deploy directly.

## Review Corrections (applied 2026-07-09)

Authoritative amendments from the plan document-review. Where these touch a unit, they
override the unit's original text.

**Orchestration & correctness**
- **RC-1 (Unit 1 — ordering) [DECIDED at Checkpoint 2]:** the SDK has no per-candidate
  confidence; the runtime "probe" is dropped. Trust `ids_for()` order by SDK-version contract
  and label rank metrics "SDK-asserted order, not independently verified." `kgEquivalentIds`
  (unscored) items append after `identifiers` items so they never hold trusted top ranks.
  The full rank-metric surface + decision matrix ships.
- **RC-2 (Unit 3 — merge):** reimplement as order-preserving list de-dup; reuse only
  `normalize_id`. (Applied inline.)
- **RC-3 (Unit 2 — gold set):** quote-aware parse, `compound_name`→name, filter to `HMDB\d+`,
  tier by `match_level` with CURATION as headline. (Applied inline.)
- **RC-4 (Unit 5/6 — restart recovery):** `recover_stale_jobs` sweeps only the `jobs` table,
  so a server restart mid-run would orphan a `benchmark_runs` row forever. Add
  `recover_stale_benchmark_runs` to the `lifespan` startup sweep (flip non-terminal runs →
  `interrupted`). **Insert the `benchmark_runs` row at dispatch** (status `pending`) so the
  sweep can recover it. Test: a run left mid-flight is marked terminal after re-init.
- **RC-5 (Unit 6 — tests):** `conftest.py` only stubs the biomapper module + exception
  classes — it does NOT provide usable client/result objects. Benchmark route/scorer tests
  must `patch("services.mapper.BioMapperClient")` with an AsyncMock and hand-built result
  fixtures (mirror `tests/test_mapper.py::_make_mock_result`); add a shared result-builder
  fixture. Do not rely on the module MagicMock to yield candidate lists.
- **RC-6 (Unit 6/9 — env in comparison):** add `env`/`base_url` to the `/compare` mismatch
  object and the Unit 9 warning banner (dev vs prod resolve to different backends — a silent
  env mismatch reads as a config win). Test: dev-env run vs prod-env run → env-mismatch warning.
- **RC-7 (Unit 4/6 — RUN_ERROR visibility):** surface per-vocab RUN_ERROR density; distinguish
  "vocab omitted: no GT" from "vocab degraded: N/N rows errored at transport," so a fully
  failing annotator can't masquerade as absent and inflate surviving vocabs.
- **RC-8 (verification):** add a network-gated, real-SDK smoke run on the committed gold set
  (marked slow/optional, like `scripts/verify_e2e_compounds`) recorded as a run artifact per
  repo SOP. Scope correctness claims: scorer arithmetic is unit-tested; real ordering/coverage
  is only proven by this smoke run, not the mocked backend tests.

**Security (Units 5/6/8 + Express proxy)**
- **RC-9 (P0 — `/compare` IDOR):** resolve run A and run B independently and enforce
  `user_id == x_clerk_user_id` on **each**; return 404 (not 403) on mismatch. Test: user A
  cannot compare user B's run.
- **RC-10 (P1 — proxy auth):** the `/api/benchmark` proxy mount must NOT copy the map proxy's
  `/stream` + `/result` auth exemption (`requireMapAuthUnlessDemoPath`). Use strict
  `requireMapAuth` on **all** `/api/benchmark/*` paths — benchmark results contain the
  curator's ground-truth dataset (sensitive), unlike generic mapping results.
- **RC-11 (P1 — payload bounds):** `BenchmarkRequest.ground_truth` has two unbounded
  dimensions beyond the 10k `names` cap. Add validators: ≤10k names, ≤20 vocabs/name, ≤500
  IDs/(name,vocab); oversized → 422.
- **RC-12 (P2 — strict SSE ownership):** `/benchmark/stream/{run_id}` uses the strict
  `jobs.py` ownership pattern (require non-None header; 404 if `run.user_id != header`), not
  `map.py`'s soft double-non-None check (which lets a header-less request read any stream).
- **RC-13 (P2/P3 — export + storage):** apply `escapeCsvField` to **every** exported column
  (`ground_truth`, `returned_ids`, `hit_ranks`, `category`, name), not just name; add
  `max_length=255` to `dataset_name`/`display_name`; **exclude `input_names` from the
  `list_benchmark_runs` response** (return it only on single-run get), mirroring how
  `list_jobs` excludes `results`. Cascade-delete `benchmark_row_logs` with the run.

**Design / IA (Units 7/8/9)**
- **RC-14 (P0 — routes):** fix the three routes as `/benchmark` (upload), `/benchmark/runs`
  (history), `/benchmark/runs/:runId` (results). Dispatch success in `benchmark.tsx` →
  `navigate('/benchmark/runs/' + runId)`; a history row → same. One settled routing contract
  across Units 7–9. `run_id` type is the backend UUID string used verbatim in URLs.
- **RC-15 (P0 — tab migration):** remove the Benchmark tab + "Coming Soon" stub from
  `upload.tsx` and add a single `AppShell` nav entry to `/benchmark` (no dual entry points).
- **RC-16 (P1 — comparison selection):** history rows get checkboxes; a "Compare" button
  activates only when exactly 2 are selected (disabled otherwise, tooltip "Select exactly 2
  runs"); additional checkboxes disable once 2 are checked; comparison opens
  `/benchmark/compare` (or an inline expansion) reading `?a=&b=`.
- **RC-17 (P1 — results states):** `benchmark-results.tsx` must specify: in-progress (reuse
  the staged progress from `use-benchmark-stream.ts`), result-fetch pending (corpus-table
  skeleton), partial/invalid run (inline banner above the table, not a blank page), fetch
  error (flagged.tsx error pattern).
- **RC-18 (P1 — dashboard hierarchy, anti-slop):** fixed column hierarchy — decision-matrix
  label leftmost/widest; primary visible: Hit@1, MAP, Hit@∞; secondary: MRR, Hit@5, Mean
  Recall@5; diagnostics (ranking gap, reranking headroom, recall headroom, norm lift, mean
  candidates) behind a per-vocab expand toggle. Ordering-unverified cells render as an
  explicit "—/SDK-asserted" chip (one agreed visual), not zeros.
- **RC-19 (P2 — empty states & destructive action):** distinct copy for the rerankable preset
  returning zero rows ("No rerankable rows — matches already at rank 1 / near ceiling") vs. a
  too-narrow manual filter ("No rows match — Clear filters"); a shadcn `AlertDialog`
  confirmation before run delete; the "N names merged" duplicate-GT notice shows **during
  column-mapping review**, before dispatch; the gold-set selector is a visible affordance
  beside the dropzone.

**Coherence / traceability**
- **RC-20:** `hit_ranks` are **0-indexed** positions (`hit_ranks[0] = 0` means the first
  candidate is a GT hit); the rerankable preset is `hit_ranks` non-empty AND
  `0 < hit_ranks[0] < 5` (first hit at rank 1–4). State this in Unit 4.
- **RC-21:** R3 is satisfied by Units 3+4 (per-(name,vocab) set model) — add to their
  Requirements lines. R13/R15 are intentionally absent: R13 folded into R11, R15 folded into
  R14 during the requirements review (see origin). Numbering is deliberately non-contiguous.
- **RC-22:** Unit 1's ordering/version output is consumed by Unit 6 (note the forward
  dependency); replace "suppressed/flagged" wording with the single "—/SDK-asserted" state
  from RC-18.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-07-09-ground-truth-benchmarking-requirements.md](docs/brainstorms/2026-07-09-ground-truth-benchmarking-requirements.md)
- Metrics spec: `biomapper-eval-metrics-design.md`
- Reference scorer (normalization only): `analysis/ms1-biomapper-concordance/io_and_normalize.py`
- Mapping pipeline: `artifacts/python-api/services/mapper.py`, `routes/map.py`,
  `services/jobs.py`, `services/database.py`, `main.py`
- Frontend: `artifacts/frontend/src/pages/upload.tsx`, `dashboard.tsx`, `flagged.tsx`,
  `hooks/use-mapping-stream.ts`, `App.tsx`, `components/AppShell.tsx`
- Codegen/proxy: `lib/api-spec/openapi.yaml`, `lib/api-spec/orval.config.ts`,
  `artifacts/api-server/src/app.ts`
- Learnings: `docs/solutions/runtime-errors/fastapi-union-return-type-crash-2026-05-17.md`,
  `docs/solutions/logic-errors/biomapper-sdk-dict-list-data-loss-2026-05-06.md`,
  `docs/solutions/build-errors/orval-generated-files-not-committed-2026-05-23.md`,
  `docs/solutions/best-practices/optimistic-ui-sync-and-atomic-cap-enforcement-2026-05-18.md`,
  `docs/solutions/best-practices/csv-formula-injection-prevention-2026-05-23.md`,
  `docs/solutions/logic-errors/preserve-original-columns-and-hint-prefix-fix-2026-05-07.md`,
  `docs/solutions/security-issues/feedback-endpoint-auth-pii-hardening.md`
