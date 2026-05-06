---
title: "feat: Upgrade to biomapper 1.1.0 with equivalent IDs for export enrichment"
type: feat
status: active
date: 2026-05-06
origin: docs/brainstorms/biomapper-1.1.0-equivalent-ids-upgrade-requirements.md
---

# feat: Upgrade to biomapper 1.1.0 with equivalent IDs for export enrichment

## Overview

Upgrade the biomapper dependency from 1.0.1 to 1.1.0 and wire the new `kgEquivalentIds` field (a `dict[str, list[str]]` mapping CURIE prefixes to local IDs) through the full stack: Python API → OpenAPI spec → generated TypeScript client → React frontend display → TSV/JSON exports. The primary user value is **data export enrichment** — equivalent ID columns in TSV downloads for downstream pipeline integration.

This also fixes a data loss bug where `list()` on a dict yields only prefix keys, not actual IDs.

## Problem Frame

The Python API currently calls `list(kg_equiv)` on a dict, producing prefix key names instead of actual identifiers. The frontend declares `kg_equivalent_ids` as `string[]` while the upstream data is `dict[str, list[str]]`. The field is absent from the OpenAPI spec entirely, with a local type override in the frontend. (see origin: `docs/brainstorms/biomapper-1.1.0-equivalent-ids-upgrade-requirements.md`)

## Requirements Trace

**Backend & SDK**
- R1. Upgrade `biomapper` dependency from 1.0.1 to 1.1.0
- R2. Python API always includes `kgEquivalentIds` (camelCase) as `dict[str, list[str]]`, never omitting the key

**API Contract & Generation**
- R7. Add `kgEquivalentIds` to OpenAPI spec; remove local type override
- R8. Regenerate API client types from updated spec

**Frontend Types & Display**
- R5. Frontend TypeScript type changes from `string[]` to `Record<string, string[]>`
- R6. `EquivalentIds` component renders local IDs under prefix headers (deliberate visual change)

**Export Enrichment**
- R3. TSV export includes `equiv_*` columns for matched vocabulary prefixes
- R4. JSON export includes full `kgEquivalentIds` dict (depends on R2+R7+R8)

## Scope Boundaries

- **Not in scope:** New UI for selecting equivalent ID prefixes — reuses existing display vocabularies selector
- **Not in scope:** Cross-reference lookups or annotation verification UI
- **Not in scope:** Changes to `MappingSummary` vocabulary coverage stats
- **Not in scope:** Batch SDK method migration

## Context & Research

### Relevant Code and Patterns

- **Mapper service** (`artifacts/python-api/services/mapper.py:_process_result`): Builds result dicts with camelCase keys (`primaryCurie`, `confidenceScore`, etc.). The `identifiers` dict uses lowercase shortname keys.
- **OpenAPI spec** (`lib/api-spec/openapi.yaml` `MappingResultItem`): Manually maintained. Uses camelCase properties. `identifiers` field uses `additionalProperties` pattern — same pattern applies for `kgEquivalentIds`.
- **Code generation** (`lib/api-spec/orval.config.ts`): Orval v8.5.3 generates to `lib/api-client-react/src/generated/` and `lib/api-zod/src/generated/`. Run via `pnpm --filter @workspace/api-spec codegen`.
- **SSE streaming path** (`artifacts/python-api/routes/map.py`, `services/jobs.py`): Raw dicts stored and serialized unchanged. No transformation needed — whatever `_process_result` returns flows through to the frontend.
- **TSV export** (`artifacts/frontend/src/pages/dashboard.tsx` `handleDownloadTSV`): Client-side. Iterates `r.identifiers` keys, filters by `visibleOntologies`. Uses pipe-separated multi-value cells.
- **JSON export** (`artifacts/frontend/src/pages/dashboard.tsx` `handleDownloadJSON`): `JSON.stringify({ summary, results })` — raw dump, so `kgEquivalentIds` will appear automatically once the type chain is correct.
- **Upload vocabulary selection** (`artifacts/frontend/src/pages/upload.tsx`): `selectedVocabPrefixes` stores uppercase CURIE prefixes (e.g., `HMDB`, `KEGG.COMPOUND`). **Lowercased** when passed as `?ontologies=` query param to dashboard — so `visibleOntologies` contains lowercased CURIE prefixes like `hmdb`, `kegg.compound`, `pubchem.compound`.
- **Dashboard ontologies filter** (`artifacts/frontend/src/pages/dashboard.tsx`): `visibleOntologies` parses the lowercase `?ontologies=` param into a `Set<string>`. These are **lowercased CURIE prefixes**, not identifiers-dict shortnames.

### Institutional Learnings

- SSE requires `proxy_buffering off` in nginx — no changes to SSE path needed for this upgrade, but keep in mind if proxy config is touched.
- Python venv at repo root (`~/biomapper-ui/.venv/`), not at `artifacts/python-api/`.

## Key Technical Decisions

- **OpenAPI spec is manually maintained**: Confirmed — direct editing of `lib/api-spec/openapi.yaml`, then `pnpm --filter @workspace/api-spec codegen`. No auto-generation from Python types.
- **`kg_equivalent_ids` is top-level on SDK MappingResult**: Confirmed — `_build_from_raw_result()` in biomapper 1.1.0 extracts it as `dict[str, list[str]]` at the model level. Direct attribute access works.
- **camelCase field name (`kgEquivalentIds`)**: All other keys in `_process_result` use camelCase (`primaryCurie`, `confidenceScore`, etc.). The Python API must emit `kgEquivalentIds` (not snake_case `kg_equivalent_ids`) to match the convention and the OpenAPI spec. No serialization middleware exists between the Python API and the frontend — the raw dict key name is what the frontend receives.
- **SSE path is transparent**: Job store holds raw dicts, `to_dict()` passes them through unchanged. No streaming path changes needed.
- **Matching strategy for equiv TSV columns**: `visibleOntologies` contains **lowercased CURIE prefixes** (e.g., `hmdb`, `kegg.compound`, `pubchem.compound`), not identifiers-dict shortnames. `kgEquivalentIds` keys are uppercase CURIE prefixes (e.g., `HMDB`, `KEGG.COMPOUND`). The matching is therefore a simple case-insensitive comparison: for each `kgEquivalentIds` key, check if `visibleOntologies.has(key.toLowerCase())`. No shortname→CURIE mapping table is needed.
- **equiv_* columns appear after identifier columns in TSV**: Natural extension of the existing column layout. Headers use the CURIE prefix from `kgEquivalentIds` (e.g., `equiv_HMDB`, `equiv_KEGG.COMPOUND`).

## Open Questions

### Resolved During Planning

- **Is `result.kg_equivalent_ids` directly accessible?** Yes — top-level attribute on biomapper 1.1.0's `MappingResult`, not nested in `raw_response`.
- **Is the OpenAPI spec manual or auto-generated?** Manual. Edit `lib/api-spec/openapi.yaml` directly, then run codegen.
- **Does the SSE path need changes?** No — raw dicts flow through unchanged.
- **What does `visibleOntologies` actually contain?** Lowercased CURIE prefixes (e.g., `hmdb`, `kegg.compound`), not identifiers-dict shortnames. The upload page lowercases the CURIE prefixes from `selectedVocabPrefixes` when building the URL param.
- **Do we need a shortname→CURIE mapping table?** No. Since `visibleOntologies` already contains lowercased CURIE prefixes and `kgEquivalentIds` keys are uppercase CURIE prefixes, matching is a simple `key.toLowerCase()` comparison. No mapping table needed.

### Deferred to Implementation

- **Behavior when a display vocabulary has no equiv data**: Empty cells in TSV, empty/absent key in JSON. No special UI treatment needed — same as when an identifier column has no data for a row.

## Implementation Units

- [ ] **Unit 1: Bump biomapper to 1.1.0 and fix Python API passthrough (camelCase)**

**Goal:** Upgrade the SDK dependency and fix the `_process_result` method to always emit `kgEquivalentIds` (camelCase) as a proper dict. This combines the dependency bump, bug fix, and naming alignment in one atomic change.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Modify: `artifacts/python-api/requirements.txt`
- Modify: `artifacts/python-api/services/mapper.py`
- Test: `artifacts/python-api/tests/test_mapper.py` (new)

**Approach:**
- Change `biomapper==1.0.1` to `biomapper==1.1.0` in requirements.txt
- Replace the conditional `getattr`/`list()` block in `_process_result` with unconditional dict passthrough using the camelCase key `kgEquivalentIds`: always set `processed["kgEquivalentIds"]` to `dict(result.kg_equivalent_ids)` if the attribute exists and is not None, otherwise `{}`
- The key must always be present in the output dict — never omitted
- Use camelCase `kgEquivalentIds` to match all other keys in `_process_result` (`primaryCurie`, `confidenceScore`, etc.)
- Note: the `if kg_equiv:` guard is a second bug — empty dicts are falsy in Python, so `{}` from the SDK would cause the key to be omitted. The fix must remove this truthiness check entirely, replacing it with unconditional assignment.
- Also add `"kgEquivalentIds": {}` to the error-path dicts in `_map_with_retry` (auth failure, rate limit, mapping error dicts) so the key is present on all result rows, not just successful ones

**Patterns to follow:**
- The existing `_process_result` method structure — camelCase keys, accessing SDK result attributes directly
- The `identifiers` dict pattern for how SDK data is extracted and serialized

**Test scenarios:**
- Happy path: Mock a biomapper `MappingResult` with `kg_equivalent_ids = {"HMDB": ["HMDB0000067"], "CHEBI": ["16113", "172955"]}` → verify `_process_result` output includes the full dict under key `kgEquivalentIds`
- Edge case: `kg_equivalent_ids` is an empty dict `{}` → verify output includes `"kgEquivalentIds": {}`
- Edge case: `kg_equivalent_ids` attribute is `None` → verify output includes `"kgEquivalentIds": {}`
- Edge case: `kg_equivalent_ids` attribute is absent (older SDK) → verify output includes `"kgEquivalentIds": {}` via `getattr` default
- Regression: verify the bug is fixed — output `kgEquivalentIds` values are dicts of ID lists, not a flat list of prefix key strings
- Regression: verify key is `kgEquivalentIds` (camelCase), not `kg_equivalent_ids` (snake_case)

**Verification:**
- Python API starts without import errors
- `_process_result` returns `kgEquivalentIds` as a dict in all cases
- Existing result fields (`identifiers`, `primaryCurie`, etc.) are unchanged

---

- [ ] **Unit 2: Add `kgEquivalentIds` to OpenAPI spec and regenerate types**

**Goal:** Add the field to the canonical API contract so generated TypeScript types include it, then remove the local type override.

**Requirements:** R5, R7, R8

**Dependencies:** Unit 1

**Files:**
- Modify: `lib/api-spec/openapi.yaml`
- Modify: `artifacts/frontend/src/types/mapping.ts`
- Regenerate: `lib/api-client-react/src/generated/api.schemas.ts`
- Regenerate: `lib/api-client-react/src/generated/api.ts`
- Regenerate: `lib/api-zod/src/generated/api.ts`

**Approach:**
- Add `kgEquivalentIds` property to `MappingResultItem` in openapi.yaml, following the same `additionalProperties` pattern as `identifiers`:
  ```yaml
  kgEquivalentIds:
    type: object
    description: |
      Map of CURIE prefix → list of equivalent local identifiers from the
      knowledge graph node. Keys are native CURIE prefixes (e.g. "HMDB",
      "KEGG.COMPOUND"). Empty when no KG match.
    additionalProperties:
      type: array
      items:
        type: string
  ```
- Run `pnpm --filter @workspace/api-spec codegen` to regenerate (this single command regenerates all three output targets: api-client-react schemas, api-client-react hooks, and api-zod validators)
- **Current type structure:** `MappingResult` in `artifacts/frontend/src/types/mapping.ts` is an interface that `extends MappingResultItem` and adds one field: `kg_equivalent_ids?: string[]`. `MappingResultItem` is the generated type from the OpenAPI spec. The dashboard and other components import `MappingResult`, not `MappingResultItem` directly.
- Remove the `kg_equivalent_ids?: string[]` override from `MappingResult` — the field is now in the generated `MappingResultItem` type as `kgEquivalentIds`
- Since `kg_equivalent_ids` is the only additional field on `MappingResult`, the interface becomes empty after removal. Replace it with a type alias: `export type MappingResult = MappingResultItem`. This preserves all existing imports and usage across the codebase (dashboard, hooks, etc.) — they continue importing `MappingResult` but now it resolves to `MappingResultItem` with the new `kgEquivalentIds` field.

**Patterns to follow:**
- The `identifiers` field definition in openapi.yaml — same `additionalProperties` pattern

**Test scenarios:**
- Happy path: After codegen, verify `MappingResultItem` in generated `api.schemas.ts` includes `kgEquivalentIds` as an optional property with type matching `Record<string, string[]>`
- Integration: TypeScript compilation passes with the updated types (`pnpm tsc --noEmit` across workspaces)

**Verification:**
- Generated types include the new field
- No TypeScript compilation errors
- The local type override in `mapping.ts` is removed

---

- [ ] **Unit 3: Update EquivalentIds component for dict input**

**Goal:** Rewrite the `EquivalentIds` component to accept `Record<string, string[]>` instead of `string[]`, rendering local IDs under prefix headers.

**Requirements:** R6

**Dependencies:** Unit 2

**Files:**
- Modify: `artifacts/frontend/src/components/EquivalentIds.tsx`
- Modify: `artifacts/frontend/src/pages/dashboard.tsx` (call site)

**Approach:**
- Change `EquivalentIdsProps` from `{ ids: string[] }` to `{ ids: Record<string, string[]> }`
- Remove the `groupByPrefix()` function — data arrives pre-grouped
- Update `PrefixGroup` to receive `{ prefix: string; ids: string[] }` instead of `{ prefix: string; curies: string[] }` — render local IDs only, not full CURIEs
- Update the count badge to show total IDs across all prefixes (sum of all arrays)
- Update the per-prefix count badge to show `ids.length`
- Sort prefixes alphabetically (same as current behavior)
- Update the dashboard call site from `row.kg_equivalent_ids ?? []` to `row.kgEquivalentIds ?? {}`
- Empty check changes from `!ids || ids.length === 0` to `!ids || Object.keys(ids).length === 0`

**Patterns to follow:**
- Current `EquivalentIds.tsx` component structure (collapsible prefix groups with badges)
- shadcn/ui Badge component usage

**Test scenarios:**
- Happy path: Component renders correctly with `{"HMDB": ["HMDB0000067"], "CHEBI": ["16113", "172955"]}` — shows CHEBI and HMDB headers with correct ID counts
- Edge case: Component receives `{}` — renders nothing (null return)
- Edge case: Component receives `undefined` — renders nothing via fallback `?? {}`
- Edge case: Prefix with single ID vs prefix with multiple IDs — both render correctly with accurate counts

**Verification:**
- Component renders in the browser on the dashboard for a resolved entity
- Prefix groups expand/collapse correctly
- Local IDs displayed (not full CURIEs)
- Total count badge shows correct aggregate

---

- [ ] **Unit 4: Add equiv_* columns to TSV export**

**Goal:** Enrich the TSV download with equivalent ID columns filtered by the user's display vocabulary selection.

**Requirements:** R3, R4

**Dependencies:** Unit 2

**Files:**
- Modify: `artifacts/frontend/src/pages/dashboard.tsx` (`handleDownloadTSV` function)

**Approach:**
- Collect all unique `kgEquivalentIds` keys across all results into a set of CURIE prefixes (guard against undefined/null: `if (r.kgEquivalentIds) Object.keys(r.kgEquivalentIds).forEach(...)`)
- Filter to only prefixes where `visibleOntologies.has(prefix.toLowerCase())`, or if `visibleOntologies` is empty, include all. This works because `visibleOntologies` contains lowercased CURIE prefixes (e.g., `hmdb`, `kegg.compound`) and `kgEquivalentIds` keys are uppercase CURIE prefixes (e.g., `HMDB`, `KEGG.COMPOUND`).
- Sort the filtered CURIE prefixes alphabetically
- For each matching prefix, add an `equiv_<PREFIX>` column header (e.g., `equiv_HMDB`, `equiv_KEGG.COMPOUND`)
- Place equiv columns after all identifier columns in the header row
- For each result row, look up `row.kgEquivalentIds?.[prefix]` and join with `|` (pipe separator), or empty string if not present
- R4 (JSON export) is automatically satisfied — `JSON.stringify({ summary, results })` already includes all fields

**Patterns to follow:**
- The existing TSV export pattern in `handleDownloadTSV` — iterate keys, filter by `visibleOntologies`, pipe-join multi-value cells
- The `vocabCols` building pattern for collecting and filtering column keys

**Test scenarios:**
- Happy path: TSV for cholesterol includes `equiv_HMDB` column with `HMDB0000067` and `equiv_CHEBI` column with `16113|172955` when those vocabularies are selected
- Happy path: equiv columns appear after all identifier columns in the header row
- Edge case: Unresolved entity row has empty cells in all equiv columns
- Edge case: Result has `kgEquivalentIds` with a prefix not in `visibleOntologies` — column is excluded from TSV
- Edge case: `visibleOntologies` is empty (no filter applied) — all equiv prefix columns included
- Edge case: Result has empty `kgEquivalentIds` (`{}`) — all equiv columns show empty cells
- Integration: JSON download for the same job includes `kgEquivalentIds` dict with the correct structure

**Verification:**
- Download TSV from the dashboard for a completed mapping job
- Open in a spreadsheet — equiv columns appear after identifier columns
- Verify known IDs match expected values for a test entity
- Download JSON — verify `kgEquivalentIds` is present and correctly structured

## System-Wide Impact

- **Interaction graph:** Change flows linearly: Python API mapper → SSE stream (transparent) → frontend type → component + export. No callbacks, middleware, or observers affected.
- **Error propagation:** `kgEquivalentIds` defaults to `{}` on error/absence. No new error states introduced. Frontend fallback `?? {}` handles undefined.
- **State lifecycle risks:** None. Job store holds raw dicts; the new field is just another key in the dict.
- **API surface parity:** The REST endpoint (`/map/result/{job_id}`) and SSE stream both carry the same result dict — no parity gap.
- **Integration coverage:** The full pipeline (Python → SSE → frontend → export) should be manually tested end-to-end since there are no integration tests.
- **Unchanged invariants:** `identifiers` dict structure and keys are completely unchanged. `MappingSummary` is unchanged. Confidence scoring, annotation mode, and all other mapping config are unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| biomapper 1.1.0 not on PyPI | Install from local `../biomapper/` repo as fallback. Package was released 2026-04-29 per git history. |
| Upstream API doesn't populate `kg_equivalent_ids` for some entity types | SDK defaults to `{}` (empty dict). Frontend handles gracefully with empty cells. |
| Orval codegen produces unexpected type for `additionalProperties` | Verify generated type after codegen. The `identifiers` field uses the same pattern successfully. |
| Pre-existing identifiers TSV mismatch for compound prefixes | The existing TSV export filters identifiers columns by `visibleOntologies` (lowercased CURIE prefixes), but identifiers dict uses shortnames (`pubchem` vs `pubchem.compound`, `kegg` vs `kegg.compound`). This means PubChem and KEGG identifier columns are already silently dropped from filtered TSV exports. After this upgrade, equiv columns for those same vocabs *will* appear (since equiv matching uses CURIE prefixes correctly), creating a visible inconsistency: `equiv_PUBCHEM.COMPOUND` shows data but the `pubchem` identifiers column is missing. This pre-existing bug should be filed as a follow-up issue. The equiv column matching avoids this issue by working directly with CURIE prefixes. |

## Sources & References

- **Origin document:** [docs/brainstorms/biomapper-1.1.0-equivalent-ids-upgrade-requirements.md](docs/brainstorms/biomapper-1.1.0-equivalent-ids-upgrade-requirements.md)
- Related code: `artifacts/python-api/services/mapper.py` (mapper `_process_result`), `lib/api-spec/openapi.yaml` (MappingResultItem), `artifacts/frontend/src/pages/dashboard.tsx` (TSV/JSON export, EquivalentIds call site)
- biomapper 1.1.0 source: `../biomapper/src/biomapper/models.py` (MappingResult with kg_equivalent_ids)
