# Fix: Provided ID Hint Column Processing & Output

**Date:** 2026-05-07
**Status:** Ready for planning
**Scope:** Lightweight — two bugs + one small UX enhancement

## Problem

When a user selects a "Provided ID Column" whose name doesn't match a known vocabulary regex (e.g., a column literally named `provided_ids` containing HMDB IDs), the system fails in two ways:

1. **Hints sent with wrong vocab key** — `inferPrefix("provided_ids")` falls back to `"PROVIDED_IDS"`, which biomapper2 doesn't recognize as a vocabulary. The IDs are silently discarded as `unrecognized_vocabs_provided`.

2. **Provided IDs absent from output** — The result processor in `artifacts/python-api/services/mapper.py:174-185` hardcodes 10 vocabulary keys. Any vocabulary not in that list is silently dropped. Additionally, the original provided ID values are never echoed back in the output, so users can't compare what they submitted vs. what biomapper found.

**Impact:** The "Provided ID Columns" feature is effectively broken for any column whose name isn't an obvious vocabulary match. In testing, 27 entities with valid HMDB IDs all mapped as "unknown" because the hints were ignored.

## Requirements

### R1: Auto-detect vocabulary from cell values

When a hint column is selected, sample the non-empty values to infer the vocabulary prefix. Use a pattern-based approach:

- `HMDB\d+` → HMDB
- `CHEBI:\d+` or bare numeric in a column named chebi-like → CHEBI
- `C\d{5}` → KEGG.COMPOUND
- `LMFA\d+`, `LMGP\d+`, etc. → LIPIDMAPS
- `RM\d+` or `RM:\d+` → refmet_id
- Numeric-only values with no clear prefix → suggest PUBCHEM.COMPOUND

Detection should sample the first ~20 non-empty values and pick the dominant match. If no pattern is recognized, fall back to the existing column-name heuristic.

### R2: User-editable prefix override

Next to each checked hint column, show an editable text input displaying the auto-detected/inferred prefix. The user can change it to any vocabulary prefix. This overrides auto-detection.

The UI currently shows a read-only label like `→ PROVIDED_IDS`. Replace this with an editable text input pre-filled with the auto-detected prefix. Leave layout, validation, and reactivity details to planning.

### R3: Echo provided IDs in output

Add columns to the TSV/JSON output that show the original provided ID values submitted as hints. This lets users compare their input against biomapper's resolved identifiers. Both the original column name and the raw cell values must be preserved through the pipeline.

- TSV/CSV: add the original column name directly as a column header (e.g., `provided_ids`) after the core columns but before the biomapper-generated identifier columns. When provided ID columns exist in the output, biomapper-generated identifier columns get a `_biomapper` suffix (e.g., `hmdb_biomapper`) to distinguish them from user-provided data; when no provided IDs are present, column names remain unchanged for backward compatibility. CSV download is a new output format added alongside this fix
- JSON: add a `providedIds` object to each result, keyed by original column name (e.g., `{ "provided_ids": "HMDB0000294" }`)
- When multiple hint columns are selected, each gets its own output column/key

### Non-goals

- Mixed-vocabulary columns (different vocab per cell) — assume one vocab per column
- Validating ID format beyond prefix detection
- Changes to biomapper2 backend — fixes are UI and Python API layer only

## Affected Files

- `artifacts/frontend/src/pages/upload.tsx` — prefix inference, hint column UI, editable override
- `artifacts/python-api/services/mapper.py` — echo provided IDs in result output
- `artifacts/python-api/models/schemas.py` — add `hintColumns` field to MappingConfig
- `lib/api-spec/openapi.yaml` — add `hintColumns` and `providedIds` to API schema
- `artifacts/frontend/src/pages/dashboard.tsx` — render provided ID columns in TSV/CSV/JSON downloads
- `artifacts/python-api/tests/test_mapper.py` — test coverage for providedIds

## Success Criteria

1. A column named `provided_ids` containing HMDB IDs auto-detects as `HMDB` prefix
2. User can manually change the detected prefix before submitting
3. Entities with valid provided HMDB IDs resolve successfully (not "unknown")
4. Output TSV includes the provided ID values as a visible column for each hint column checked by the user
5. The existing column-name heuristic still works for columns like `hmdb_id`, `CHEBI`, etc.
6. When provided ID columns are present, biomapper-generated columns use `_biomapper` suffix; when absent, column names remain unchanged
7. CSV download option is available alongside existing TSV/JSON/Markdown
