# MS1 ↔ Biomapper Concordance Study

Runs MS1-annotated analytes through the Biomapper pipeline and compares the resulting
cross-database identifiers against a set of curated reference annotations.

- **Input** (in `data/`, git-ignored — unpublished):
  - `unique_features_by_best_tier.csv` — the names to map (`feature_id, matched_name, match_level`).
  - `All_Methods_Features.xlsx` — per-method spectral features; the source of **input-side hints**.
  - `per_metabolite_annotation.csv` — the **curated reference** (ground truth) to compare against.
- **Output** (in `outputs/<timestamp>/`, git-ignored):
  - `mapped_final.csv` — UI-style export: all original reference columns preserved, with Biomapper's name-only mappings appended (`*_biomapper` suffix, parallel to the original ID columns).
  - `comparison.csv` — analysis/scoring view: per-feature reference-vs-Biomapper IDs and agreement class per namespace.
  - `report.md` — concordance summary; `raw_*.json` — raw pass results.

## Method

Two passes through `biomapper.map_entities`:

- **name-only** — maps `matched_name` with no hints. **This is the authoritative concordance
  comparison** (an independent test of Biomapper vs the curated reference).
- **hinted** — also feeds **input-side** hints. Hints come ONLY from the input files (HMDB IDs
  parsed from `ms1/ms2_compound_name`, CAS from `ms2_cas_id` in the xlsx) — **never** from the
  curated reference (that would be circular). A namespace hinted for a feature is excluded from
  that feature's concordance (`__hinted_here`); only HMDB among the scored namespaces is
  hintable (CAS is not scored).

Per scored namespace (HMDB, ChEBI, KEGG.COMPOUND, PUBCHEM.COMPOUND, LIPIDMAPS, RefMet) each
feature is classified `agree_exact` / `agree_partial` / `disagree` / `new_coverage` /
`missed` / `none`. IDs are unioned from Biomapper's `identifiers` **and** `kg_equivalent_ids`
(the latter holds most cross-refs), normalized so reference-format and Biomapper-format compare
equal (incl. LipidMaps `LM`-prefix reconciliation).

**RefMet** is scored by converting Biomapper's RefMet **IDs** → **names** via the Metabolomics
Workbench REST API (`refmet/refmet_id/<id>/name/`), the RefMet authority Biomapper itself uses.
Only the distinct IDs for comparable features are looked up, cached on disk
(`outputs/refmet_names_cache.json`) so reruns are free. No bulk download required.

## Setup

Use the biomapper venv (`../../../biomapper/.venv`) — it has `biomapper>=1.2.1`, pandas,
openpyxl, pytest. The API key is read from the repo root `.env` via `python-dotenv`
(`BIOMAPPER_API_KEY`) — **do not** `export` it on the command line (shell-history leak) and
never print it.

```bash
VENV="../../../biomapper/.venv"         # adjust if your layout differs
"$VENV/bin/python" -m pytest tests/ -q  # 56 tests, no API calls
```

Optional: `BIOMAPPER_BASE_URL` overrides the backend (confirm dev vs prod — the runner
prints the target `base_url`).

## Run

```bash
"$VENV/bin/python" run_comparison.py --limit 20   # smoke run (small paid call)
"$VENV/bin/python" run_comparison.py              # full run, two passes (paid)
"$VENV/bin/python" run_comparison.py --no-hinted  # name-only only
```

Reliability: runs are sub-batched (`--sub-batch`, default 50) with pauses to avoid bursting the
upstream Kestrel rate limit; a per-sub-batch health guard retries once then aborts on a degraded
backend, and degraded runs never poison the reload cache. Re-runs reload `outputs/raw/*.json` and
skip the paid API when the name-set is unchanged.

## Reading the report

`outputs/<timestamp>/report.md`:

- **Concordance by namespace** — agreement over a *sized* comparable denominator (both sides have
  an ID), with the comparable subset as a fraction of all features. Covers only the
  double-annotated subset.
- **Hinted-pass cross-namespace agreement** — name-only vs hinted agreement per namespace
  (circular cases excluded). A negative Δ means the spectral input hint steered Biomapper away
  from the curated identity.
- **New coverage** — UNVALIDATED candidates by confidence tier. No ground truth exists here;
  spot-check ≥20/tier against an authority before trusting.

Open questions for the data owner: (1) what success bar makes Biomapper useful here;
(2) provenance of the curated IDs (cross-walk vs independent), which bounds how much weight
agreement can bear.

## Confidentiality

`comparison.csv`, `mapped_final.csv`, and `report.md` embed the curated reference IDs — share
them only via the original channel; never commit `data/`/`outputs/` or post them to a shared
repo. Clear notebook outputs before committing (`jupyter nbconvert --clear-output --inplace explore.ipynb`).
