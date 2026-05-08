# Preserve All Original Columns in Output Downloads

**Date:** 2026-05-07
**Status:** Ready for planning
**Scope:** Standard — cross-cutting data flow change (upload → storage → dashboard)

## Problem

When users upload a dataset, the pipeline extracts only the name column and hint column values. All other original columns (e.g., `feature_id`, `match_level`, `issue_category`, sample labels, metabolite IDs) are dropped. The downloadable output (TSV/CSV/JSON) contains only biomapper-generated data, making it hard for users to reconcile results with their original dataset. Users expect to get their data back enriched, not replaced.

## Requirements

### R1: Preserve all original rows and columns

The output downloads (TSV/CSV) must include every row and every column from the user's uploaded file, unchanged. Original column names and values are preserved exactly as uploaded. JSON downloads add an `originalRows` array alongside the existing `summary` and `results` structure (no breaking change to JSON format).

- All original rows are preserved, including duplicates (if two rows have the same entity name, both appear in the output)
- Biomapper results for each row are joined by matching on the entity name column (using the same trim normalization as the deduplication step). The original name column value is preserved byte-for-byte in the output; only the join uses the trimmed form for lookup
- Rows with the same entity name get the same biomapper result columns
- The selected name column must be stored alongside the parsed rows so the dashboard can perform the join

### R2: Suffix biomapper-generated columns with `_biomapper`

All columns added by the pipeline get a `_biomapper` suffix so users can immediately distinguish their data from pipeline-added enrichment:

- Identifier columns: `hmdb_biomapper`, `chebi_biomapper`, `pubchem_biomapper`, etc.
- Equivalent ID columns: `equiv_HMDB_biomapper`, `equiv_CHEBI_biomapper`, etc.
- Core result columns: `resolved_biomapper`, `primary_curie_biomapper`, `confidence_tier_biomapper`, `confidence_score_biomapper`, `needs_review_biomapper` (these replace the current "Resolved", "Primary Curie", etc. headers in downloads; "Original Name" is NOT suffixed since it is the join key, not a biomapper-generated column)

The `_biomapper` suffix is always applied when original columns are present in the output. This replaces the conditional suffix behavior from `provided-ids-hint-column-fix-requirements.md` (SC6), where biomapper columns received the suffix only when provided ID columns were present. When original row data is not available (e.g., direct URL navigation to a job), downloads fall back to the current column naming.

### R3: Store original data client-side via IndexedDB

The parsed rows from the upload page must survive navigation to the dashboard page. Use IndexedDB (via `idb-keyval` or similar) keyed by job ID to store the original parsed data. IndexedDB has no practical size limit, handling files up to 10K rows with many columns. This avoids API changes.

- Store parsed rows and selected name column after job creation, keyed by job ID
- Retrieve on the dashboard page when generating downloads
- Clean up old entries when no longer needed
- When original row data is not available in storage (direct navigation, session expired), downloads fall back to the current results-only format
- If a column name in the original file collides with a biomapper column name (e.g., user has a column named `hmdb_biomapper`), the biomapper column gets an additional suffix (e.g., `hmdb_biomapper_2`)

### R4: Column ordering in output

Output columns should follow this order:
1. All original columns (in their original order)
2. Biomapper core result columns (with `_biomapper` suffix)
3. Biomapper identifier columns (with `_biomapper` suffix)
4. Biomapper equivalent ID columns (with `_biomapper` suffix)

### Non-goals

- Showing original columns in the dashboard results table (downloads only)
- Modifying the API request/response to carry original row data
- Changing the dashboard table view or its column structure

## Affected Files

- `artifacts/frontend/src/pages/upload.tsx` — store parsedRows + selectedColumn in IndexedDB after job creation
- `artifacts/frontend/src/pages/dashboard.tsx` — retrieve original rows, join with results, generate output with all columns

## Success Criteria

1. Downloaded TSV/CSV contains all original columns from the uploaded file, unchanged
2. All biomapper-generated columns have `_biomapper` suffix
3. Output has the same number of rows as the original file (duplicates preserved)
4. Original column names and values are byte-for-byte identical to the upload
5. Works for files up to 10,000 rows (the existing name limit)
6. Dashboard table view is unchanged
