---
title: "Biomapper SDK upgrade: list() on dict data loss and kgEquivalentIds full-stack wiring"
date: 2026-05-06
category: logic-errors
module: biomapper-ui
problem_type: logic_error
component: tooling
severity: high
root_cause: logic_error
resolution_type: dependency_update
symptoms:
  - "KG equivalent IDs in API responses contained only prefix key names instead of actual identifier data"
  - "Entities with empty equivalent IDs had the field silently omitted due to falsy truthiness check on empty dict"
  - "Frontend TypeScript type declared string[] while upstream data was dict[str, list[str]]"
  - "kgEquivalentIds field absent from OpenAPI spec — no codegen contract"
tags:
  - biomapper-sdk
  - python-api
  - openapi-codegen
  - data-loss
  - dict-keys-vs-values
  - camelcase-naming
  - orval
  - typescript-project-references
---

# Biomapper SDK upgrade: list() on dict data loss and kgEquivalentIds full-stack wiring

## Problem

The Python API in biomapper-ui called `list()` on the biomapper SDK's `kg_equivalent_ids` dict, silently converting `{"HMDB": ["HMDB0000067"], "CHEBI": ["16113", "172955"]}` into `["HMDB", "CHEBI"]` — losing all actual identifier data. A secondary bug: `if kg_equiv:` dropped empty dicts (falsy in Python) for entities with no KG match, omitting the field entirely. The frontend declared the wrong type (`string[]`), the field was absent from the OpenAPI spec, and TSV exports had no equivalent ID columns.

## Symptoms

- API responses had `kg_equivalent_ids` containing prefix key names like `["HMDB", "CHEBI"]` instead of the full identifier mapping
- Entities with no equivalent IDs (empty dict `{}`) had the field silently omitted from responses
- `EquivalentIds` component in the dashboard rendered prefix names as if they were CURIEs
- TSV/JSON exports contained no equivalent ID data
- No TypeScript compilation errors despite the type mismatch — the field was declared locally with a `string[]` override, bypassing codegen

## What Didn't Work

- **Assumed `visibleOntologies` contained shortnames**: The initial plan built a shortname-to-CURIE mapping table (`hmdb` → `HMDB`, `kegg` → `KEGG.COMPOUND`). Investigation during plan review revealed `visibleOntologies` actually contains lowercased CURIE prefixes (`hmdb`, `kegg.compound`) — the mapping table was unnecessary and the correct approach was simple case-insensitive comparison. (session history)

- **Separated SDK bump from camelCase rename**: The first plan draft had the version bump + passthrough fix as Unit 1 and the field rename to camelCase as a separate Unit 5. Plan reviewers caught this would create a broken intermediate state where the API emits `kg_equivalent_ids` (snake_case) but the OpenAPI spec and frontend expect `kgEquivalentIds` (camelCase). No serialization middleware exists between the Python API and the frontend — the raw dict key name is what the frontend receives. The units were merged into one atomic change. (session history)

- **Used `del` on MagicMock to simulate absent attribute**: `del result.kg_equivalent_ids` on a `MagicMock` does not raise `AttributeError` on subsequent access — `MagicMock.__getattr__` intercepts all access and returns a child mock. The test appeared to pass because `dict(MagicMock())` happens to return `{}` via empty `keys()` iteration, but it never exercised the `getattr` fallback. Greptile caught this during PR review.

- **Forgot to rebuild TypeScript project reference declarations**: After running orval codegen with `clean: true`, the `lib/api-client-react/dist/` directory was wiped. The frontend uses TypeScript project references (`composite: true`, `outDir: "dist"`), so removing dist caused TS6305 errors. The fix was to run `tsc -b` in the api-client-react package directory to regenerate `.d.ts` declarations before re-running the frontend type check. (session history)

## Solution

The fix spans all layers of the stack:

**1. Python API** (`artifacts/python-api/services/mapper.py`):
```python
# Before (broken):
kg_equiv = getattr(result, "kg_equivalent_ids", None)
if kg_equiv:
    processed["kg_equivalent_ids"] = list(kg_equiv)  # list() on dict = keys only!

# After (fixed):
kg_equiv = getattr(result, "kg_equivalent_ids", None)
processed["kgEquivalentIds"] = dict(kg_equiv) if kg_equiv is not None else {}
```
Also added `"kgEquivalentIds": {}` to all 6 error-path dicts in `_map_with_retry` (auth failure, rate limit, config error, abort, mapping error, retry exhaustion) — these bypass `_process_result` and would otherwise omit the field.

**2. OpenAPI spec** (`lib/api-spec/openapi.yaml`):
```yaml
kgEquivalentIds:
  type: object
  description: |
    Map of CURIE prefix to list of equivalent local identifiers from the
    knowledge graph node. Keys are native CURIE prefixes (e.g. "HMDB",
    "KEGG.COMPOUND"). Empty object when no KG match.
  additionalProperties:
    type: array
    items:
      type: string
```
Not nullable — the Python API always emits it (defaults to `{}`).

**3. Codegen + build**: `pnpm --filter @workspace/api-spec codegen` then `tsc -b` in `lib/api-client-react/` to rebuild project reference declarations.

**4. Frontend types** (`artifacts/frontend/src/types/mapping.ts`): Removed the local `kg_equivalent_ids?: string[]` override. `MappingResult` became a type alias for the generated `MappingResultItem`.

**5. EquivalentIds component**: Rewrote to accept `Record<string, string[]>`. Removed `groupByPrefix()` (data arrives pre-grouped). Renders local IDs under prefix headers with `?? []` defensive guards on value access.

**6. TSV export** (`artifacts/frontend/src/pages/dashboard.tsx`): Added `equiv_*` columns after identifier columns. Matching uses case-insensitive CURIE prefix comparison: `visibleOntologies.has(prefix.toLowerCase())`. No shortname mapping table needed.

**7. Tests**: Used `PropertyMock(side_effect=AttributeError)` to properly simulate absent SDK attribute.

## Why This Works

The root cause was `list()` on a dict returning only keys, compounded by a falsy guard dropping valid empty dicts. The fix passes the dict through with `dict(kg_equiv)` (defensive copy) and uses explicit `is not None` check so `{}` is preserved. The camelCase rename aligns with the existing naming convention (`primaryCurie`, `confidenceScore`, etc.) and the OpenAPI spec. TSV column matching is simple because `visibleOntologies` already contains lowercased CURIE prefixes — the same namespace as `kgEquivalentIds` keys, just different casing.

## Prevention

- **Never call `list()` on a dict when you intend to preserve its structure** — `list(some_dict)` returns keys only. Use `dict(some_dict)` for a shallow copy or pass through directly.

- **Empty dicts are falsy in Python** — use `is not None` instead of truthiness checks when `{}` is a valid zero-value. This applies to any dict field that can legitimately be empty.

- **When adding fields to the manually-maintained OpenAPI spec**, always rebuild TypeScript project reference declarations after codegen:
  ```bash
  pnpm --filter @workspace/api-spec codegen
  cd lib/api-client-react && npx tsc -b
  ```

- **Test absent attributes on MagicMock with `PropertyMock`**:
  ```python
  from unittest.mock import PropertyMock
  type(result).kg_equivalent_ids = PropertyMock(side_effect=AttributeError)
  ```
  Do not use `del` — MagicMock auto-creates attributes on access.

- **Trace data flow before building mapping tables** — read from the source (upload page) through URL params to the consumer (dashboard) to verify what values actually arrive. Assumptions about intermediate data shapes are a common source of over-engineering.

- **When no serialization middleware exists**, the Python dict key name IS the JSON key name. Ensure new fields use the same convention (camelCase in this codebase) from the first commit, not as a later rename.

## Related Issues

- [PR #6](https://github.com/trentleslie/biomapper-ui/pull/6): Feature implementation (feat/biomapper-1.1.0-equivalent-ids → dev)
- [PR #7](https://github.com/trentleslie/biomapper-ui/pull/7): Release to main (dev → main)
- `docs/brainstorms/biomapper-1.1.0-equivalent-ids-upgrade-requirements.md`: Requirements document
- `docs/plans/2026-05-06-001-feat-biomapper-1.1.0-equivalent-ids-plan.md`: Implementation plan
- **Known follow-up**: Pre-existing TSV identifier column mismatch — `identifiers` dict uses shortname keys (`pubchem`, `kegg`) while `visibleOntologies` contains lowercased CURIE prefixes (`pubchem.compound`, `kegg.compound`), causing PubChem/KEGG identifier columns to be silently dropped from filtered exports
