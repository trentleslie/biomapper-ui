# Many-cohort example: source

**The cohorts are invented for demonstration.** `example_cohort_a` to `example_cohort_e` are not real studies. No participant data and no data from any real cohort is included, and no row was copied from any cohort's data file.

- Analyte names are common metabolite names and synonyms. The identifiers (HMDB in every file, KEGG in `example_cohort_c.tsv` and `example_cohort_d.tsv`) are public identifiers from the Human Metabolome Database and KEGG COMPOUND, written from knowledge of those public vocabularies.
- Generated on 2026-11-13 by this project's build (biomapper-ui, harmonization groundwork), for biomapper 1.9.0.
- Files: five cohort files of 16 rows each, `<label>.tsv` with columns `id`, `name`, `hmdb` (and `kegg` for c and d), and `spec.json` (the `POST /harmonize/many` spec, cohorts in the order a to e).

## What the rows are chosen to show

- **Groups across cohorts:** Glucose, Urea, Cholesterol, Creatinine and Alanine appear in most cohorts with the same HMDB code, often under different names (Glucose and D-Glucose, Lactate, L-Lactate and L-Lactic acid).
- **Synonyms:** Ascorbic acid and Vitamin C, Cortisol and Hydrocortisone, Uric acid and Urate, Hippuric acid and Hippurate, Betaine and Glycine betaine.
- **Group with multiplicity:** Leucine appears twice in `example_cohort_a.tsv` (a06, a07).
- **Case-only name pair:** `Co` (cobalt) in `a` and `CO` (carbon monoxide) in `b` and `e` differ only by case. It was meant to show a withheld name match, but in the recorded run the engine resolved all three to the same node (RM:0051008), so they form one ordinary group. That wrong group is kept as recorded.
- **Identifier that does not agree:** c06 Creatinine carries HMDB0000294, which is urea. In the recorded identifier arm it moves c06 into the urea group (a group with multiplicity) and produces a cross-node review entry between the creatinine and urea nodes.
- **Vocabulary declared by only some cohorts:** KEGG is declared by `c` and `d` only.
- **Rows not grouped:** each cohort has one placeholder name with no meaning (`###`, `???`, `%%%`, `&&&`, `###`). Made-up words were not used because the engine resolves almost any word to some node.
- **Recorded review entries not designed in:** the names-only arm also flags a few rows whose correct HMDB code the identifier check did not confirm against the chosen node (for example Glucose with HMDB0000122). They are kept as recorded.

## Recording

`recording/` holds one real run of this example against the hosted BioMapper API, made with `scripts/record_harmonize_run.py many_cohort`. `recording/PINS.md` gives the biomapper version, the report's pins, the date, the command and the git SHA. The replay backend reads it when `BIOMAPPER_HARMONIZE_REPLAY_DIR` points at `data/harmonize_examples`.
