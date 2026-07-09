---
date: 2026-07-09
topic: ground-truth-benchmarking
---

# Ground-Truth Benchmarking (BioMapper UI)

## Problem Frame

BioMapper resolves compound/entity names to canonical identifiers across many target
vocabularies (HMDB, ChEBI, PubChem, RefMet, LIPID MAPS, UniProt, …), returning a
candidate list per vocabulary. Today there is no way inside the UI to measure how *good*
those resolutions are against known-correct answers. The `biomapper-eval-metrics-design.md`
spec defines the scoring semantics in full but defers implementation, and the UI's
"Benchmark" tab is a "Coming Soon" placeholder.

Two audiences are served by one shared scoring core:
- **Curators bringing their own data** — a user uploads names plus known-correct IDs and
  sees how BioMapper performed on *their* dataset, down to the individual disagreeing row.
- **Internal QA / config tuning** — the team measures BioMapper accuracy against a curated
  gold set to see where resolution is strong vs. weak and, crucially, whether a config
  change *improved* things (change config → re-run → compare).

**Sequencing decision (post-review):** build an **HMDB-first vertical** end-to-end
(ingestion → scoring core → metrics/diagnostics → per-row review → durable persistence →
a minimal two-run comparison), rather than the full multi-vocabulary surface up front.
The multi-vocabulary breadth is built to be **additive**: the ingestion format, scorer, and
persistence schema all support N vocabularies, but slice 1 validates and ships HMDB against
real ground truth. This avoids shipping (and having to maintain) multi-vocab machinery that
cannot be validated until non-HMDB ground truth exists.

## Requirements

**Ground-Truth Ingestion**
- R1. A user can upload a CSV of benchmark cases in **wide format**: one name column plus
  one ground-truth column per target vocabulary (e.g. `name`, `gt_hmdb`, `gt_chebi`, …).
  Multiple valid IDs in a cell are `;`-separated. An empty cell means "no ground truth for
  this vocabulary" and that (name, vocabulary) pair is excluded from that vocabulary's
  denominators. The format supports N vocabularies; slice 1 exercises `gt_hmdb`.
- R2. A column-mapping step lets the user map which uploaded column is the name and which
  column feeds which vocabulary (headers need not match a fixed schema).
- R3. Ground truth is modeled internally as a **set of IDs per (name, vocabulary)**,
  handling single- and multi-item ground truth uniformly (design's `|GT| ≥ 1` case).
- R4. A curated **HMDB gold set** derived from `biomapper_ui_test_dataset.csv` ships as a
  selectable day-one benchmark input, so there is something to run without hand-authoring.
  **Verified reality (review finding):** the CSV as-is does NOT conform to R1 — its columns
  are `feature_id, compound_name, match_level, issue_category, provided_ids`, with no
  `gt_<vocab>` columns. Its only ground-truth-like IDs live in `provided_ids`, populated on
  only ~31 of 100 rows (mostly `CURATION`-tier, e.g. `urea → HMDB0000294`). Deriving the
  gold set is a relabel step (curated `provided_ids` → `gt_hmdb`, drop unpopulated rows).

**Scoring Core**
- R5. A backend scoring service implements `biomapper-eval-metrics-design.md`: per-vocab ID
  normalization, exact-match fast path then normalized match, and a canonical per-row
  `hit_ranks` field from which all per-row metrics derive. **Review finding:** the offline
  `analysis/ms1-biomapper-concordance/` code is set-overlap *concordance* (no `hit_ranks`,
  no IR metrics) — it can inform normalization/ID-handling but the `hit_ranks` scorer is
  built fresh from the design spec.
- R6. Each scored row is classified into exactly one category: `EXACT_MATCH`,
  `NORMALIZED_MATCH`, `NO_OVERLAP`, `GROUND_TRUTH_EMPTY`, `RETURNED_EMPTY`,
  `MALFORMED_GROUND_TRUTH`, `MALFORMED_RETURNED`.
- R7. The scorer reuses the existing mapping pipeline to produce candidate lists, then
  scores — no second, divergent path to BioMapper. **Two verified constraints:**
  (a) HMDB/PubChem IDs often arrive via `kgEquivalentIds`, not `identifiers`, so the scorer
  must **merge both per-vocabulary sources**; (b) confidence-ordering is an *unverified
  assumption* — `mapper.py` passes `ids_for()` through unsorted — so ordering must be probed
  before rank-sensitive metrics are trusted (see Deferred). Benchmark runs must **forbid or
  clearly flag `config.hints`**, which would feed the mapper the answer and inflate Hit@1.

**Metrics & Diagnostics Display**
- R8. A corpus summary shows, per (dataset, vocabulary) cell: n, MAP, MRR, Hit@1, Hit@5,
  Hit@∞, Mean Recall@5, Mean candidates returned, and normalization lift. Slice 1 renders
  the HMDB row; the table structure is vocabulary-ready so added vocabularies are new rows.
- R9. Diagnostic gaps are surfaced, not just raw scores: ranking gap (Hit@∞ − Hit@1),
  reranking headroom (Hit@5 − Hit@1), recall headroom (Mean Recall@∞ − Mean Recall@5), and
  normalization lift, with the design's reranking decision-matrix interpretation attached
  to each vocabulary (not floated in a separate legend).
- R10. Vocabularies with no ground truth are represented honestly (empty/omitted cells),
  never as zeros that read like failures.

**Per-Row Disagreement Review**
- R11. A per-row review table lists every scored row with name, vocabulary, ground_truth,
  returned_ids, hit_ranks, and category; filterable by category and vocabulary and sortable
  by rank. It includes a built-in **"rerankable rows" filter preset** — `hit_ranks` non-empty
  AND `0 < hit_ranks[0] < 5` (a GT item found, not at rank 0, within top-5; equivalent to
  `category ∈ {EXACT_MATCH, NORMALIZED_MATCH}` with first hit at rank 1–4). This single
  `hit_ranks` formulation is canonical (matches the design doc). *(This preset replaces the
  former standalone R13 rerankable-export requirement.)*
- R12. Any current table view — full log or the rerankable-rows preset — is exportable as
  CSV/JSONL matching the design's log format.

**Persistence & Comparison**
- R14. Each benchmark run is persisted **durably** with a stable primary key: its input
  names, full mapping `config`, the biomapper SDK/API version + environment (the true
  determinant of candidate coverage and ordering), the corpus metrics, and the per-row
  disagreement log — so a run is reproducible and re-viewable/re-exportable after it
  completes. **Verified reality (review finding):** a durable `aiosqlite` layer already
  exists (`services/database.py`, `jobs` table, survives restart); only the in-memory
  `JobStore` (1-hour TTL) is transient. Extend that DB (add benchmark-run + per-row-log
  tables) and write scoring results synchronously at scoring time — *not* into the
  ephemeral job payload, which is purged after an hour. *(Durable storage with a stable key
  is itself sufficient to enable a later comparison unit; the former R15 "forward-compat"
  framing is folded into this requirement rather than standing as a separate constraint.)*
- R16. A **minimal two-run comparison view**: pick two persisted runs and see their corpus
  metrics (and per-vocabulary diagnostic gaps) side by side with the delta, so the internal
  QA loop (change config → re-run → did Hit@1 / MAP improve?) is actually closed in slice 1.
  This is the two-run delta only — not the full cross-config framework deferred by the
  design doc (no trend charts, no N-way matrices, no config sweep orchestration).

## Success Criteria
- A curator can go from "names + known-correct IDs" to a corpus metrics table and a
  filterable per-row disagreement log entirely within the UI, with no offline scripts.
- Running the built-in HMDB gold set produces metrics that are **reproducible and
  verifiable against a hand-scored expectation** (fixed known `hit_ranks`/Hit@1 for a small
  set of rows). *(The earlier "consistent with the offline reference" criterion was dropped —
  that reference is an order-free set-overlap concordance study with no rank metrics and no
  single oracle, so it is not numerically comparable to IR metrics.)*
- The reranking decision (ship / rerank / add annotators / fix upstream drift) can be read
  off the diagnostic gaps for a vocabulary without computing anything by hand.
- Two persisted runs can be compared and the metric deltas read directly (R16).
- A persisted run can be reopened later and its per-row log / rerankable subset re-exported.

**Oracle caveat (must accompany any HMDB number):** embedded HMDB annotations are MSI
Level 3 (least reliable) and MS1/HMDB concordance is near-circular. HMDB metrics validate
the *pipeline mechanics*, not absolute resolution quality. Trustworthy accuracy claims
require the scheduled higher-reliability gold set (curated/MS2-adjudicated, or non-HMDB
vocabularies) — see Scope Boundaries.

## Scope Boundaries
- **Full multi-vocabulary surface** — deferred as *additive*. Format/scorer/schema support
  N vocabularies, but only HMDB is validated and shipped in slice 1; other vocabulary
  columns are accepted but flagged unvalidated until real GT + per-vocab ordering
  verification exist.
- **Higher-reliability gold set** — scheduled as the next unit of work (HMDB validates
  mechanics now; a trustworthy gold set makes the numbers decision-grade).
- **Full cross-config comparison framework** (trend charts, N-way matrices, config sweeps)
  — deferred to the design doc's separate "benchmarking process" document. Slice 1 ships
  only the minimal two-run delta (R16).
- **LLM reranker construction** — out of scope; this feature produces the *signal*
  (reranking headroom) and the *training data* (the R11 rerankable-rows preset export).
- **True-negative detection** — slice 1 measures **positives only**. Empty GT cells are
  treated uniformly as "unannotated / excluded from denominators"; it does not distinguish a
  genuine "no valid ID exists in this vocabulary" true-negative. Documented limitation;
  revisit with the trustworthy gold set. *(Default decision — flag if true-negatives should
  be in scope.)*
- **Confidence-score calibration** (ECE, reliability diagrams) — separate workstream.
- **Cross-vocabulary reconciliation** ("returned ChEBI but GT is HMDB — same compound?") —
  handled downstream by KRAKEN, not this scorer.
- **Fuzzy name matching** — not in the scorer; name drift handled via vocabulary
  normalization only. (Note: RefMet normalization is name-based, so RefMet "IDs" behave as
  fuzzy-name matching — call this out when RefMet is eventually added.)
- **Inline curator actions on disagreeing rows** (flag/correct/feed-back with the existing
  flag feature) — deferred to keep benchmarking decoupled from flagging for this slice.

## Key Decisions
- **HMDB-first vertical, multi-vocab additive** (revised from "full surface" after review):
  no non-HMDB ground truth exists to validate the multi-vocab machinery, and HMDB is a weak
  oracle — so validate the core end-to-end on HMDB and generalize when real GT arrives.
- **Both gold sets, sequenced**: HMDB gold set now (mechanics), trustworthy set scheduled
  next (decision-grade numbers).
- **Minimal two-run delta comparison in-scope** (R16): closes the internal-QA tuning loop
  without pulling in the deferred full comparison framework.
- **Wide-format upload** over long-format triples or single-column auto-detect: matches a
  curator's spreadsheet mental model and can express "no GT for vocab X" via empty cells.
- **Reuse the existing mapping pipeline** then score: one source of truth for how BioMapper
  is called; inherits streaming/progress. Scorer merges `identifiers` + `kgEquivalentIds`.
- **R13 folded into an R11 filter preset; R15 folded into R14**: the rerankable subset is a
  saved filter/export, not a standalone contract for an out-of-scope reranker; durable
  persistence with a stable key already enables later comparison without a standing
  forward-compat constraint.
- **Positives-only scoring for slice 1**: true-negative detection deferred.

## Dependencies / Assumptions
- **Confidence-ordering is UNVERIFIED (review finding).** The design *assumes*
  `identifiers[vocabulary]` is descending-confidence, but `mapper.py::_process_result`
  passes `result.ids_for()` through with no sort; the offline reference treats these as
  *sets*. Must be probed per vocabulary before rank metrics are trusted.
- **HMDB/PubChem IDs may live in `kgEquivalentIds`, not `identifiers` (review finding).**
  `mapper.py` stores `kgEquivalentIds` separately; a scorer reading only `identifiers` would
  score HMDB ~zero. Merge both per-vocabulary sources.
- A durable `services/database.py` (aiosqlite, `jobs` table) already exists; extending it is
  the persistence path. The transient piece is the in-memory `JobStore` (1-hour TTL).
- Reference code in `analysis/ms1-biomapper-concordance/` is set-overlap concordance, not a
  drop-in `hit_ranks` scorer (verified).

## Outstanding Questions

### Resolve Before Planning
- *(none — all product/scope decisions resolved: HMDB-first vertical, both gold sets
  sequenced, minimal two-run comparison in-scope, R13→R11 preset, R15→R14, positives-only.)*

### Deferred to Planning
- [Affects R5/R8][Verify FIRST] Probe whether `result.ids_for()` returns
  descending-confidence order **per vocabulary**. Suppress/flag rank-sensitive metrics where
  ordering is unconfirmed.
- [Affects R7][Verify] Confirm the merged `identifiers` + `kgEquivalentIds` per-vocab source
  set and how the "candidate list" is assembled (and ordered) before scoring.
- [Affects R7/R14][Correctness] Enforce forbid/flag of `config.hints` in benchmark runs;
  pin SDK version + input names with the persisted run.
- [Affects R5][Technical] Which normalization/ID-handling to port from the offline code vs.
  implement fresh; malformed-ID handling per the design's `ValueError` contract.
- [Affects R7][Technical] Eval-run orchestration: reuse existing job/SSE flow + scoring
  pass, or a dedicated eval-job type — persisting durably before the 1-hour job purge.
- [Affects R14/R16][Technical] Persistence schema (runs + per-row-log tables) and the
  two-run comparison query.
- [Affects R2][Design] Column-mapping interaction (per-column role dropdowns + auto-detect +
  inline validation + first-rows preview).
- [Affects R7/UI][Design] Run progress model (upload → mapping → scoring) via SSE with
  stage/completed payloads; loading/empty/error states.
- [Affects R1/R2][Design] Upload validation & error states (non-CSV, unparseable, no name
  column, no GT columns, per-cell parse failures → MALFORMED categories).
- [Affects R14/IA][Design] Benchmark run-history entry point / list view (persisted runs
  currently have no UI reopen path; the Benchmark tab holds only the placeholder).
- [Affects R8/R9/R11][Design] Metric hierarchy & decision-matrix presentation (avoid a
  uniform many-cell AI-slop grid); MALFORMED-row rendering.
- [Affects R11][Needs research] Rendering the per-row log at scale (100s–1000s of rows) —
  pagination/virtualization consistent with the existing dashboard.

## Next Steps
-> /ce:plan for structured implementation planning
