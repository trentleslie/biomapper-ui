---
date: 2026-05-06
topic: biomapper-1.1.0-equivalent-ids-upgrade
---

# Biomapper 1.1.0 Upgrade: Equivalent IDs for Export Enrichment

## Problem Frame

Biomapper-UI currently depends on `biomapper==1.0.1`. The Python API partially extracts `kg_equivalent_ids` from the SDK result, but mishandles the data — calling `list()` on a dict yields prefix keys only, not actual IDs. The frontend type declares `string[]` while the upstream data is `dict[str, list[str]]`. This is a known data loss bug that will be fixed as part of this upgrade (not separately).

Biomapper 1.1.0 formalizes `kg_equivalent_ids` as a typed `dict[str, list[str]]` field on `MappingResult`, mapping CURIE prefixes to their local IDs (e.g., `{"HMDB": ["HMDB0000067"], "CHEBI": ["16113", "172955"]}`). It also adds an `equivalent_ids_for(prefix)` convenience accessor.

The primary user value is **data export enrichment**: users need equivalent IDs in their TSV and JSON downloads so downstream pipelines can cross-reference entities across databases without a separate ID-mapping step.

## Requirements

**SDK Upgrade**
- R1. Upgrade `biomapper` dependency from 1.0.1 to 1.1.0
- R2. Python API always includes `kg_equivalent_ids` in the processed result dict as `dict[str, list[str]]` using native CURIE prefix keys (e.g., `HMDB`, `KEGG.COMPOUND`). When the SDK field is absent, `None`, or an empty dict, set the value to `{}`. Never omit the key from the response.

**Export Enrichment**
- R3. TSV export includes `equiv_*` columns (e.g., `equiv_HMDB`, `equiv_CHEBI`) for each user-selected display vocabulary prefix that has a matching key in `kg_equivalent_ids`. Matching requires a prefix-mapping layer since display vocabulary shortnames (`hmdb`, `kegg`) differ from CURIE prefixes (`HMDB`, `KEGG.COMPOUND`). Multiple IDs within a prefix are pipe-separated. Rows without equivalent IDs for a given prefix get empty cells.
- R4. JSON export includes the full `kg_equivalent_ids` dict per result row. Note: this requires R2 (Python API passthrough), R7 (OpenAPI spec update), and R8 (client type regeneration) to all be complete so the field flows through the full pipeline (Python API → OpenAPI spec → generated client types → frontend results array → JSON serialization). Verify end-to-end during testing rather than implementing separately.

**Frontend Type & Display**
- R5. Frontend TypeScript type for `kg_equivalent_ids` changes from `string[]` to `Record<string, string[]>`
- R6. The `EquivalentIds` component renders from the pre-grouped dict. Each prefix group header shows the prefix name; items underneath show local IDs only (not full CURIEs). This is a deliberate visual change from the current display of full CURIEs. Collapsible prefix groups with counts are preserved. The dashboard call site fallback must change from `row.kg_equivalent_ids ?? []` to `row.kg_equivalent_ids ?? {}`.

**API Contract**
- R7. Add `kg_equivalent_ids` as a new optional property on MappingResultItem in openapi.yaml with type `object` (additionalProperties: array of strings). Remove the local type override in `types/mapping.ts` that currently declares it as `string[]`.
- R8. Generated API client types regenerated from the updated spec

## Success Criteria

- TSV download for a known entity (e.g., "cholesterol") includes `equiv_HMDB`, `equiv_CHEBI`, etc. columns with verifiable IDs (e.g., cholesterol's HMDB ID is HMDB0000067, CHEBI local IDs include 16113) when those vocabularies are selected
- TSV download for an unresolved entity shows empty cells in equiv columns (not missing columns or errors)
- JSON download includes the full `kg_equivalent_ids` dict per result, with the same verified IDs
- `EquivalentIds` component displays local IDs under prefix headers with correct counts
- `kg_equivalent_ids` values in API response are dicts mapping prefix strings to arrays of actual identifiers (e.g., `{"HMDB": ["HMDB0000067"]}`), not arrays of prefix key strings (e.g., `["HMDB", "CHEBI"]`). This confirms the `list()`-on-dict bug from 1.0.1 is resolved.
- No regressions in existing mapping, streaming, or download functionality

## Scope Boundaries

- **Not in scope:** New UI for selecting equivalent ID prefixes — reuses the existing display vocabularies selector
- **Not in scope:** Cross-reference lookups or annotation verification UI — those will be handled by the biomapper package natively in the future
- **Not in scope:** Changes to `MappingSummary` vocabulary coverage stats (equivalent IDs would overcount since one entity can have multiple IDs per prefix)
- **Not in scope:** Batch SDK method migration — separate concern from this upgrade
- **Not in scope:** Fixing the `list()` bug separately on 1.0.1 — the upgrade itself is the fix

## Key Decisions

- **Reuse display vocabularies for equiv column selection**: The existing vocabulary multi-select on the upload page controls both dashboard display columns and equivalent ID export columns. Avoids a new concept for users to learn.
- **Pass through native CURIE prefixes**: `kg_equivalent_ids` keys are passed through from the SDK as-is (e.g., `HMDB`, `KEGG.COMPOUND`). The frontend handles mapping between display vocabulary shortnames and CURIE prefixes for filtering.
- **Local IDs under prefix headers in UI**: The `EquivalentIds` component shows local IDs only (not full CURIEs), since the prefix is already visible as the group header. This is cleaner and less redundant.
- **Pipe-separated multi-value cells in TSV**: When an entity has multiple equivalent IDs for a prefix (e.g., two CHEBI IDs), they are pipe-separated in a single cell. This matches the existing convention for identifier columns.
- **`equiv_` prefix on column names**: Distinguishes equivalent ID columns from the existing identifier columns (which come from the `identifiers` dict, a different field).
- **Upgrade is the bug fix**: The existing `list()` on dict bug is fixed by this upgrade, not separately. No value in a 1.0.1 hotfix that would be immediately replaced.

## Dependencies / Assumptions

- Biomapper 1.1.0 is published and installable from PyPI (or installable from the local `../biomapper/` repo)
- The upstream BioMapper2 API returns `kg_equivalent_ids` in its response — the SDK models it but the field is only populated when the API provides it
- The upgrade is fully backward compatible per biomapper 1.1.0's design (no breaking changes)

## Implementation Order

R1 → R2 → R7 → R8 → R5 → R6 → R3. R4 is verified after R2+R7+R8 are complete.

## Outstanding Questions

### Deferred to Planning
- [Affects R2][Technical] Confirm that `result.kg_equivalent_ids` is directly accessible on the SDK's `MappingResult` object (not nested inside `raw_response`)
- [Affects R3][Technical] Determine whether `equiv_*` columns should appear after all existing identifier columns or interspersed with them
- [Affects R3][Needs research] Build the prefix-mapping layer between display vocabulary shortnames (`hmdb`, `kegg`, `pubchem`) and CURIE prefixes (`HMDB`, `KEGG.COMPOUND`, `PUBCHEM.COMPOUND`). Investigate the full set of mismatches.
- [Affects R7][Technical] Verify the OpenAPI spec generation workflow and whether it's manual or auto-generated

## Next Steps

-> `/ce:plan` for structured implementation planning
