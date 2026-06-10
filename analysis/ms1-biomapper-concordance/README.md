# MS1 ↔ Biomapper Concordance Study

Runs the reference's MS1-annotated analytes through the Biomapper pipeline and compares the
resulting cross-database identifiers against his curated annotations.

- **Input** (in `data/`, git-ignored — the unpublished input data): `unique_features_by_best_tier.csv`,
  `per_metabolite_annotation.csv` (the curated ground truth), `All_Methods_Features.xlsx`.
- **Output** (in `outputs/<timestamp>/`, git-ignored):
  - `mapped_final.csv` — UI-style export: all original input columns preserved, with Biomapper's name-only mappings appended (`*_biomapper` suffix, parallel to the original ID columns).
  - `comparison.csv` — analysis/scoring view: per-feature reference-vs-Biomapper IDs and agreement class per namespace.
  - `report.md` — concordance summary; `raw_*.json` — raw pass results.

## Method

Two passes through `biomapper.map_entities`:

- **name-only** — maps `matched_name` with no hints. **This is the authoritative concordance
  comparison** (an independent test of Biomapper vs the reference curation).
- **hinted** — also feeds the reference's existing IDs as resolver hints. Reported as **resolution
  lift only**; hinted-namespace agreement is circular and excluded from concordance.

Per scored namespace (HMDB, ChEBI, KEGG.COMPOUND, PUBCHEM.COMPOUND, LIPIDMAPS, RefMet) each
feature is classified `agree_exact` / `agree_partial` / `disagree` / `new_coverage` /
`missed` / `none`. IDs are unioned from Biomapper's `identifiers` **and** `kg_equivalent_ids`
(the latter holds most cross-refs), normalized so reference-format and Biomapper-format compare
equal (incl. LipidMaps `LM`-prefix reconciliation).

## Setup

Use the biomapper venv (`../../../biomapper/.venv`) — it has `biomapper>=1.2.1`, pandas,
openpyxl, pytest. The API key is read from the repo root `.env` via `python-dotenv`
(`BIOMAPPER_API_KEY`) — **do not** `export` it on the command line (shell-history leak) and
never print it.

```bash
VENV="../../../biomapper/.venv"        # adjust if your layout differs
"$VENV/bin/python" -m pytest tests/ -q  # 42 tests, no API calls
```

Optional: `BIOMAPPER_BASE_URL` overrides the backend (confirm dev vs prod — the runner
prints the target `base_url`).

## Run

```bash
"$VENV/bin/python" run_comparison.py --limit 20   # smoke run (small paid call)
"$VENV/bin/python" run_comparison.py              # full 2,725-feature run, two passes (paid)
"$VENV/bin/python" run_comparison.py --no-hinted  # name-only only
```

Re-runs reload `outputs/raw/*.json` (keyed by pass + backend) and skip the paid API when the
name-set is unchanged.

## RefMet (optional, recommended)

Biomapper returns RefMet **IDs**; the reference has RefMet **names**. To score RefMet, drop the
RefMet master list as `data/refmet.csv` with `refmet_id` + `refmet_name` columns (download
once from Metabolomics Workbench and pin the version). The same file also enables the
chemical-class axis (the reference classes are RefMet classes). Without it, RefMet rows are marked
`bridge_unavailable`.

## Reading the report

`outputs/<timestamp>/report.md`:

- **Concordance by namespace** — agreement over a *sized* comparable denominator (both sides
  have an ID), with the comparable subset as a fraction of all features. This covers only the
  double-annotated subset.
- **New coverage** — UNVALIDATED candidates by confidence tier. No ground truth exists here;
  spot-check ≥20/tier against an authority before trusting.
- **Hinted lift** — features newly resolved when given a hint.

Open questions for the data owner: (1) what success bar makes Biomapper useful here;
(2) provenance of his curated IDs (cross-walk vs independent), which bounds how much weight
agreement can bear.

## Confidentiality

`comparison.csv` and `report.md` embed the curated reference IDs — share them with the reference via the
channel he used; never commit `data/`/`outputs/` or post them to a shared repo. Clear notebook
outputs before committing (`jupyter nbconvert --clear-output --inplace explore.ipynb`).
