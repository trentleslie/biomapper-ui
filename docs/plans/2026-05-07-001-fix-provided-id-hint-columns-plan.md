---
title: "fix: Provided ID hint column prefix inference, override, and output echo"
type: fix
status: active
date: 2026-05-07
origin: docs/brainstorms/provided-ids-hint-column-fix-requirements.md
---

# fix: Provided ID Hint Column Prefix Inference, Override, and Output Echo

## Overview

The "Provided ID Columns" feature in the upload page is broken for columns whose names don't match a known vocabulary regex. The prefix inference fallback produces unrecognized keys (e.g., `PROVIDED_IDS`), biomapper2 silently discards the hints, and the original provided IDs are never echoed back in the output. This plan fixes three things: value-based prefix auto-detection (R1), user-editable prefix override (R2), and round-tripping provided IDs through the output (R3).

## Problem Frame

When a user uploads a dataset with a column named `provided_ids` containing HMDB IDs and checks it as a hint column, the UI infers the prefix as `PROVIDED_IDS` (the uppercased column name fallback). Biomapper2 doesn't recognize this as a vocabulary, so the hints are silently ignored. In testing, 27 entities with valid HMDB IDs all mapped as "unknown." Additionally, the original provided ID values are never returned in the output, so users can't compare what they submitted against biomapper's results. (see origin: `docs/brainstorms/provided-ids-hint-column-fix-requirements.md`)

## Requirements Trace

- R1. Auto-detect vocabulary from cell values when column name heuristic fails
- R2. User-editable prefix override on each checked hint column
- R3. Echo original provided ID values (with original column names) in TSV/JSON output
- SC1. Column named `provided_ids` with HMDB IDs auto-detects as `HMDB`
- SC2. User can manually change the detected prefix before submitting
- SC3. Entities with valid provided HMDB IDs resolve successfully
- SC4. Output TSV includes provided ID values for each checked hint column
- SC5. Existing column-name heuristic still works for `hmdb_id`, `CHEBI`, etc.

## Scope Boundaries

- One vocab per column — no mixed-vocabulary columns
- No ID format validation beyond prefix detection
- No changes to biomapper2 backend — fixes are UI and Python API layer only
- No frontend test infrastructure (none exists currently)

## Context & Research

### Relevant Code and Patterns

- `artifacts/frontend/src/pages/upload.tsx` — `inferPrefix()` (line 76-82), `COLUMN_PREFIX_HINTS` (line 50-67), `hintColumnPrefixMap` useMemo (line 158-166), `hintsPayload` useMemo (line 170-188)
- `artifacts/python-api/services/mapper.py` — `_map_with_retry()` hint extraction (line 81-84), `_process_result()` hardcoded vocab dict (line 174-185)
- `artifacts/python-api/services/jobs.py` — `Job.results` is `list[dict[str, Any]]`, schema-free
- `artifacts/frontend/src/pages/dashboard.tsx` — TSV download (line 217-276), JSON download (line 205-215)
- `lib/api-spec/openapi.yaml` — `MappingResultItem` schema (line 283-330)
- `artifacts/python-api/tests/test_mapper.py` — existing `_process_result` tests

### Institutional Learnings

- OpenAPI spec is manually maintained; after editing, run `pnpm --filter @workspace/api-spec codegen` then `tsc -b` (docs/solutions/logic-errors/biomapper-sdk-dict-list-data-loss-2026-05-06.md)
- Python dict keys must be camelCase from the start — no serialization middleware exists
- Do not override generated types locally; let OpenAPI spec be single source of truth
- `visibleOntologies` contains lowercased CURIE prefixes; matching requires case-insensitive comparison

## Key Technical Decisions

- **Value-based inference runs client-side in the existing useMemo**: The parsed rows are already in memory. Sample the first 20 non-empty values per column synchronously. No async or server call needed.
- **Prefix overrides stored in separate state**: A `prefixOverrides: Record<string, string>` state variable holds user edits. The `hintColumnPrefixMap` useMemo checks overrides first, then falls back to auto-detection. This prevents useMemo recomputation from clobbering user edits.
- **Provided IDs threaded through mapper.py, not reconstructed in frontend**: The mapper already has access to `config.hints` per entity name. Injecting a `providedIds` field into each result dict before storing in the job keeps the data self-contained. The frontend doesn't need to carry parsed rows across page navigation.
- **Output preserves original column names; biomapper columns get `_biomapper` suffix only when provided IDs are present**: User's original columns (e.g., `provided_ids`) appear in the output with their original names. When provided ID columns exist in the results, biomapper-generated identifier columns use a `_biomapper` suffix (e.g., `hmdb_biomapper`, `chebi_biomapper`) to distinguish them from user-provided data. When no provided IDs exist, column names remain unchanged (backward-compatible). This is a UI-only presentation choice — the backend `identifiers` dict keys are unaffected.
- **Duplicate names with different provided IDs accumulate into arrays**: When multiple rows share the same entity name but have different provided IDs for the same prefix, the values are collected into an array rather than last-row-wins.

## Open Questions

### Resolved During Planning

- **Where does R3 data originate?** From `config.hints` in mapper.py — the hints dict already maps entity names to `{ prefix: value }` pairs. The mapper can reverse-map to include the original column name by also storing it.
- **How to pass original column names to the backend?** Extend the `hints` payload to also carry column-name metadata. The simplest approach: add a `hintColumns` field to `MappingConfig` that maps prefix → original column name (e.g., `{ "HMDB": "provided_ids" }`). This is a lightweight config addition.

### Deferred to Implementation

- Exact tie-breaking rule when value-based detection produces no clear winner (implementer should pick the most common match)
- Whether prefix override state persists when a hint column is unchecked and re-checked (implementer should use simplest approach)

## Implementation Units

- [ ] **Unit 1: Value-based prefix inference + editable override (upload.tsx)**

**Goal:** Fix prefix detection for non-obvious column names and let users override the result.

**Requirements:** R1, R2, SC1, SC2, SC5

**Dependencies:** None

**Files:**
- Modify: `artifacts/frontend/src/pages/upload.tsx`

**Approach:**
- Create a `VALUE_PREFIX_PATTERNS` array of `[RegExp, string]` pairs for detecting vocab from cell values: `HMDB\d+` → HMDB, `CHEBI:\d+` → CHEBI, `C\d{5}` → KEGG.COMPOUND, `LM[A-Z]{2}\d+` → LIPIDMAPS, `RM\d+` → refmet_id, pure numeric → PUBCHEM.COMPOUND
- Refactor `inferPrefix(columnName)` to `inferPrefix(columnName, sampleValues?: string[])`. When `sampleValues` is provided, try value-based detection first (majority vote across first 20 non-empty values), fall back to column-name regex heuristic
- Add `prefixOverrides` state: `Record<string, string>` initialized empty
- Update `hintColumnPrefixMap` useMemo to: (1) check `prefixOverrides[col]` first, (2) call `inferPrefix(col, sampledValues)` as fallback. Sample values from `parsedRows` for each column
- Replace the read-only `→ {inferred}` label with an editable text input, pre-filled with the detected prefix. On change, update `prefixOverrides[col]`. If the user clears the field to empty, fall back to the auto-detected prefix (treat empty as "use auto-detected"). Show the input only when the column is checked
- Keep `COLUMN_PREFIX_HINTS` intact — the column-name heuristic remains the fallback within `inferPrefix` when no value patterns match
- Update `hintsPayload` construction: when duplicate names have different provided IDs for the same prefix, accumulate values into arrays instead of last-row-wins overwrite. Note: this accumulation is for R3 echo-back only — the mapper still sends only the first value to `client.map_entity()` since the biomapper SDK accepts `dict[str, str]`, not arrays
- If two hint columns resolve to the same prefix, show a warning in the UI but allow submission (rare edge case; last-column-wins for the `hintColumns` mapping)

**Patterns to follow:**
- Existing `COLUMN_PREFIX_HINTS` pattern for regex → prefix mapping
- Existing `hintColumnPrefixMap` useMemo pattern

**Test scenarios:**
- Happy path: Column named `provided_ids` with values like `HMDB0000294`, `HMDB0000138` → auto-detects prefix `HMDB`
- Happy path: Column named `hmdb_id` with any values → still detects prefix `HMDB` via column-name heuristic (SC5 regression check)
- Happy path: User overrides auto-detected prefix from `HMDB` to `CHEBI` → `hintColumnPrefixMap` reflects `CHEBI`
- Edge case: Column with mixed values (some `HMDB\d+`, some empty) → detects HMDB from non-empty values
- Edge case: Column with 15 HMDB-formatted values and 5 CHEBI-formatted values → auto-detects HMDB (dominant match by majority vote)
- Edge case: Column with no recognizable patterns and non-matching name → falls back to uppercased column name
- Edge case: Column with non-standard zero-padding (`HMDB02362` instead of `HMDB0002362`) → still matches HMDB pattern

**Verification:**
- Checking a column named `provided_ids` with HMDB values shows `HMDB` in the editable prefix field, not `PROVIDED_IDS`
- The editable field accepts user input and the hints payload reflects the override
- Existing column-name-based inference remains functional

---

- [ ] **Unit 2: Add `hintColumns` config + `providedIds` response field to OpenAPI spec + codegen**

**Goal:** Extend the API contract to support (a) passing original column name metadata in the request and (b) returning provided IDs in the response.

**Requirements:** R3

**Dependencies:** None (can run in parallel with Unit 1)

**Files:**
- Modify: `lib/api-spec/openapi.yaml`
- Regenerated: `lib/api-client-react/src/generated/api.ts`, `lib/api-client-react/src/generated/api.schemas.ts`, `lib/api-zod/src/generated/`

**Approach:**
- Add `hintColumns` to `MappingConfig` schema as an **optional** field (not in `required` list) with default `{}`: `type: object, additionalProperties: { type: string }` — maps inferred prefix to original column name (e.g., `{ "HMDB": "provided_ids" }`)
- Add `providedIds` to `MappingResultItem` schema as an **optional** field with default `{}`: `type: object, additionalProperties: { oneOf: [string, array of strings] }` — maps original column name to raw value(s)
- Run codegen: `pnpm --filter @workspace/api-spec codegen`
- Rebuild types: `cd lib/api-client-react && npx tsc -b`

**Patterns to follow:**
- Existing `hints` field pattern in `MappingConfig` for open dict schemas
- Existing `kgEquivalentIds` field pattern in `MappingResultItem` for open dict response fields

**Test expectation:** none — schema-only change, verified by successful codegen + type compilation

**Verification:**
- Codegen succeeds without errors
- `tsc -b` compiles cleanly
- Generated `MappingResultItem` type includes `providedIds` field

---

- [ ] **Unit 3: Thread hints metadata through mapper results + send hintColumns from frontend**

**Goal:** Pass original column name metadata in the request and populate `providedIds` in each mapper result with the raw hint values keyed by original column name.

**Requirements:** R3, SC3

**Dependencies:** Unit 1 (`hintColumnPrefixMap` must exist for inversion), Unit 2 (OpenAPI schema must exist)

**Files:**
- Modify: `artifacts/python-api/models/schemas.py`
- Modify: `artifacts/python-api/services/mapper.py`
- Modify: `artifacts/frontend/src/pages/upload.tsx`
- Test: `artifacts/python-api/tests/test_mapper.py`

**Approach:**
- Add `hint_columns: dict[str, str] = {}` field to `MappingConfig` Pydantic model (maps prefix → original column name)
- In upload.tsx `handleSubmit`, build and send `hintColumns` alongside `hints` in the config payload (invert `hintColumnPrefixMap` to get `{ prefix: columnName }`)
- In `_map_with_retry`, after extracting `hints` for the current name, also build a `providedIds` dict by reverse-mapping: for each `(prefix, value)` in the hints, look up the original column name via `config.hint_columns.get(prefix, prefix)` and use that as the key
- Inject `providedIds` into the result dict in `_map_with_retry` after the `_process_result` call returns (do not modify `_process_result`'s static method signature)
- Add `"providedIds": {}` to all error/skip return dicts in `_map_with_retry` for consistency
- Use camelCase key `providedIds` in the result dict (no serialization middleware)

**Patterns to follow:**
- Existing `kgEquivalentIds` field population pattern in `_process_result`
- Existing `config.hints` access pattern in `_map_with_retry`

**Test scenarios:**
- Happy path: Entity with hints `{"HMDB": "HMDB0000294"}` and hintColumns `{"HMDB": "provided_ids"}` → result includes `providedIds: {"provided_ids": "HMDB0000294"}`
- Happy path: Entity with no hints → result includes `providedIds: {}`
- Edge case: Multiple hint columns (e.g., HMDB + CHEBI) → both appear in `providedIds` keyed by their original column names
- Edge case: Entity name not in hints dict → `providedIds` is empty dict

**Verification:**
- Mapper results include `providedIds` field with correct values
- The hints are still correctly passed to `client.map_entity()` as `identifiers` (no regression)
- Tests pass

---

- [ ] **Unit 4: Display provided IDs in dashboard downloads**

**Goal:** Include provided ID columns in TSV and JSON downloads so users can compare their input against biomapper results.

**Requirements:** R3, SC4

**Dependencies:** Unit 2 (generated types), Unit 3 (data available in results)

**Files:**
- Modify: `artifacts/frontend/src/pages/dashboard.tsx`

**Approach:**
- In `handleDownloadTSV` (and new `handleDownloadCSV`): collect all unique keys from `r.providedIds` across results. Use the original column name directly as the column header (e.g., `provided_ids`). Position these after core columns but before biomapper-generated identifier columns. When provided ID columns exist, add `_biomapper` suffix to biomapper-generated identifier columns (e.g., `hmdb` → `hmdb_biomapper`); when no provided IDs exist, keep original names (backward-compatible). CSV uses comma delimiter with proper quoting; TSV uses tab delimiter
- In `handleDownloadJSON`: no changes needed — `providedIds` is already part of the result object and will be serialized automatically via `JSON.stringify({ summary, results })`
- In the results table: optionally show provided ID columns if any exist (follow the same `visibleVocabCols` pattern but for provided IDs). Table headers do NOT get `_biomapper` suffix — the suffix is only for file downloads where column name disambiguation matters
- When `providedIds` contains arrays (from duplicate names with different IDs), join with pipe delimiter `|` for TSV/CSV output
- Add a CSV download button alongside the existing TSV/JSON/Markdown buttons

**Patterns to follow:**
- Existing `equivCols` column collection + rendering pattern in `handleDownloadTSV`
- Existing `kgEquivalentIds` display pattern

**Test scenarios:**
- Happy path: Results with `providedIds: {"provided_ids": "HMDB0000294"}` → TSV/CSV has `provided_ids` column with value, biomapper columns have `_biomapper` suffix
- Happy path: Results with no provided IDs → biomapper columns use original names (no `_biomapper` suffix), backward-compatible
- Edge case: Multiple provided ID columns → each appears as separate column using its original name
- Edge case: Provided ID is an array (duplicate names) → values joined with `|` in TSV/CSV
- Happy path: JSON download includes `providedIds` field on each result object
- Happy path: CSV download produces properly quoted comma-separated output

**Verification:**
- Downloaded TSV/CSV has original column names for user data and `_biomapper` suffixed columns for generated data (only when provided IDs present)
- Downloads without provided IDs maintain backward-compatible column names
- JSON download includes providedIds data
- CSV download button appears and produces valid CSV
- Results table headers do NOT show `_biomapper` suffix

---

- [ ] **Unit 5: End-to-end verification with test dataset**

**Goal:** Verify the complete fix using the existing test dataset.

**Requirements:** SC1, SC2, SC3, SC4, SC5

**Dependencies:** Units 1-4

**Files:**
- Reference: `biomapper_ui_test_dataset.csv`

**Approach:**
- Upload the test dataset, select `compound_name` as name column, check `provided_ids` as hint column
- Verify the prefix field auto-detects as `HMDB`
- Run the mapping job
- Verify that entities with provided HMDB IDs (e.g., urea, tryptophan, succinate) resolve successfully
- Download TSV and verify the `provided_ids` column contains the original values and biomapper columns have `_biomapper` suffix

**Test expectation:** none — manual integration verification

**Verification:**
- Previously "unknown" entities with HMDB IDs now resolve
- Output TSV includes a `provided_ids` column with the original HMDB values, and biomapper columns have `_biomapper` suffix
- Prefix auto-detection shows `HMDB`, not `PROVIDED_IDS`

## System-Wide Impact

- **API surface**: New optional `hintColumns` field in request config and `providedIds` field in response. Both are additive and backward-compatible — existing clients that don't send `hintColumns` or read `providedIds` are unaffected
- **Job store**: No changes needed — `results` is `list[dict[str, Any]]`, additional fields are stored automatically
- **Error propagation**: No new error paths — prefix detection failures fall back gracefully to existing behavior
- **Unchanged invariants**: The `identifiers` dict in responses remains hardcoded to 10 vocabulary keys. The existing shortname-vs-CURIE-prefix mismatch (noted in learnings) is not addressed in this fix

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Value-based detection regex too broad (e.g., `C\d{5}` matches non-KEGG IDs) | Column-name heuristic runs first; value-based is fallback. User can always override via R2 |
| OpenAPI spec change breaks existing clients | Both new fields are optional with defaults (empty dict). Fully backward-compatible |
| Prefix override state management complexity | Keep it simple — `Record<string, string>` state, cleared on file change |

## Sources & References

- **Origin document:** [provided-ids-hint-column-fix-requirements.md](docs/brainstorms/provided-ids-hint-column-fix-requirements.md)
- **Institutional learnings:** `docs/solutions/logic-errors/biomapper-sdk-dict-list-data-loss-2026-05-06.md`
- Related code: `artifacts/frontend/src/pages/upload.tsx`, `artifacts/python-api/services/mapper.py`
