---
title: Uploaded columns dropped from downloads and hint prefix silently discarded
date: 2026-05-07
category: logic-errors
module: biomapper-ui
problem_type: logic_error
component: frontend_stimulus
severity: high
symptoms:
  - Downloaded TSV/CSV contained only biomapper-generated columns; original columns (feature_id, match_level, issue_category) were absent
  - 27 entities with valid HMDB IDs in a column named "provided_ids" mapped as "unknown" despite correct data being present
  - Resolution rate was 69% instead of the expected 95%+
  - No error or warning surfaced to the user about dropped columns or failed hint routing
root_cause: logic_error
resolution_type: code_fix
tags:
  - data-pipeline
  - column-preservation
  - indexeddb
  - hint-columns
  - prefix-inference
  - download-handler
  - tsv-output
  - provided-ids
---

# Uploaded Columns Dropped from Downloads and Hint Prefix Silently Discarded

## Problem

The biomapper-ui pipeline silently discarded all user-uploaded CSV columns during mapping. Users uploaded files with columns like `feature_id`, `compound_name`, `match_level`, `issue_category`, `provided_ids`, but downloads contained only biomapper-generated results keyed by deduplicated entity names. Users couldn't reconcile results with their original dataset. Additionally, hint columns with names like `provided_ids` fell back to the prefix key `PROVIDED_IDS`, which biomapper2 did not recognize as a vocabulary, causing 27 entities with valid HMDB IDs to map as "unknown."

## Symptoms

- Downloaded TSV/CSV contained only biomapper result columns; all original uploaded columns were absent
- Column named `provided_ids` containing HMDB IDs (e.g., `HMDB0000294`) was sent to the backend with prefix `PROVIDED_IDS` instead of `HMDB`
- Entities with valid provided HMDB IDs resolved as "unknown" (69% resolution rate vs 95.5% with the fix)
- No error or warning was shown to users about dropped columns or failed hint routing

## What Didn't Work

- **Browser cache caused false failure of IndexedDB.** After deploying the fix to dev-link, test uploads still produced old-format downloads. The code was confirmed deployed correctly in the bundle. A hard refresh (Ctrl+Shift+R) resolved it — the browser was loading a cached JS bundle. (session history)
- **Dev deployment had wrong env routing.** The dev deployment's `.env` had both `BIOMAPPER_BASE_URL` and `BIOMAPPER_DEV_BASE_URL` pointing to `:8003` (dev biomapper). Selecting "Production" in the UI toggle still hit the dev API. Fix: corrected `BIOMAPPER_BASE_URL` to `:8001`. (session history)
- **The `_biomapper` suffix nearly became unconditionally applied.** An adversarial reviewer caught that the original plan applied the suffix to all downloads regardless of whether original columns were present, which would have broken downstream scripts expecting `hmdb` or `chebi` headers. Revised to conditional: suffix only when original data is present. (session history)

## Solution

### Part 1: Value-based prefix auto-detection and editable override

The column name `provided_ids` doesn't encode vocabulary information. Name-based prefix derivation that isn't explicitly mapped produces a garbage key.

- Added `VALUE_PREFIX_PATTERNS` array for detecting vocabulary from cell values (HMDB, CHEBI, KEGG, LIPIDMAPS, RefMet, PubChem) with majority-vote sampling of the first 20 non-empty values
- Replaced the read-only prefix label (`-> PROVIDED_IDS`) with a user-editable text input pre-filled with the auto-detected prefix
- Added `hintColumns` config field to pass column name metadata to the backend (maps prefix to original column name)
- Propagated `providedIds` through all mapper return paths (success, skip, error) via a `_build_provided_ids` helper in `map_batch`

Key files: `artifacts/frontend/src/pages/upload.tsx`, `artifacts/python-api/services/mapper.py`, `lib/api-spec/openapi.yaml`

### Part 2: Original column preservation via IndexedDB

The root cause was architectural — the backend only returned its own computed fields, and the frontend discarded the original parse after navigation. The upload page unmounts on route change (wouter `<Switch>`), destroying all React state including `parsedRows`.

- Added `idb-keyval` (~600B gzipped) for IndexedDB persistence
- Created `artifacts/frontend/src/lib/original-data-store.ts` with `save`, `load`, `delete` functions keyed by job ID
- Upload page awaits IndexedDB write before navigation, wrapped in `try/catch` so storage failures don't block the flow
- Dashboard download handlers load original rows from IndexedDB at download time (not render time) and join with biomapper results by entity name column
- All original columns preserved unchanged; biomapper-generated columns receive `_biomapper` suffix
- Column name collision detection adds `_2` suffix when a biomapper column would shadow an original column
- TSV escape function sanitizes embedded tabs and newlines
- JSON export adds `originalRows` alongside `summary` and `results` (backward-compatible)
- Graceful fallback to results-only format when IndexedDB data is unavailable

Key files: `artifacts/frontend/src/lib/original-data-store.ts` (new), `artifacts/frontend/src/pages/upload.tsx`, `artifacts/frontend/src/pages/dashboard.tsx`

## Why This Works

**Hint prefix:** Sampling cell values directly (e.g., recognizing `HMDB\d+` patterns) makes detection robust to arbitrary column naming conventions. The user-editable override provides a safety valve when auto-detection is ambiguous.

**Column preservation:** By persisting raw uploaded rows in IndexedDB at upload time (keyed by job ID), the data survives navigation and async job completion without requiring backend schema changes. The join at download time by the name column reconstructs the full row. The `_biomapper` suffix on generated columns makes provenance unambiguous.

## Prevention

- **Never derive semantic keys from column names alone** when the values themselves encode the semantics. Validate prefix detection against cell content at ingestion time and surface the detected value for user confirmation.
- **Instrument silent fallback paths.** The `PROVIDED_IDS` fallback should have logged a warning rather than proceeding silently with an unrecognized prefix.
- **Propagate user-supplied fields through all code branches**, including error and skip paths. A pattern of "populate result struct fields before any early return" prevents silent data loss in multi-path functions.
- **Persist user input before async work begins.** Storing the original rows in IndexedDB before job submission decouples data preservation from job success and prevents loss on navigation or session change.
- **Test hint column routing with realistic column names** (e.g., `provided_ids`, `user_ids`) that do not match expected prefix patterns, to catch name-based fallback failures.
- **Hard refresh after frontend deploys.** Vite's content-hashed filenames should bust caches, but the HTML entry point can still serve stale bundle references. Verify with a hard refresh after deploy.

## Related Issues

- [biomapper-sdk-dict-list-data-loss-2026-05-06.md](../logic-errors/biomapper-sdk-dict-list-data-loss-2026-05-06.md) — related pipeline issue: `list()` on dict data loss for `kgEquivalentIds`. Same codegen pipeline, same download handler area. That doc's "Known follow-up" about `identifiers` shortname vs CURIE prefix mismatch is adjacent to this fix.
- PR #8: fix/provided-id-hint-columns (merged to dev)
- PR #9: feat/preserve-original-columns (merged to dev)
- PR #10: dev → main production release
