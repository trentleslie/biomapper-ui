# Two-cohort example: source

**The cohorts are invented for demonstration.** `example_cohort_a` and `example_cohort_b` are not real studies. No participant data and no data from any real cohort is included, and no row was copied from any cohort's data file.

- Analyte names are common metabolite names and synonyms. The identifiers (HMDB in both files, KEGG in `a.tsv`) are public identifiers from the Human Metabolome Database and KEGG COMPOUND, written from knowledge of those public vocabularies.
- Generated on 2026-11-13 by this project's build (biomapper-ui, harmonization groundwork), for biomapper 1.9.0.
- Files: `a.tsv` (30 rows: `id`, `name`, `hmdb`, `kegg`), `b.tsv` (30 rows: `id`, `name`, `hmdb`), `spec.json` (the `POST /harmonize/cohorts` spec: `a` declares HMDB and KEGG, `b` declares HMDB).

## What the rows are chosen to show

- **Plain links:** the same compound in both cohorts with the same HMDB code, often under a different name (Glucose and D-Glucose, Citric acid and Citrate, Alanine and L-Alanine).
- **Synonyms:** Ascorbic acid and Vitamin C, Cortisol and Hydrocortisone, Uric acid and Urate, 3-Hydroxybutyric acid and beta-Hydroxybutyrate, Palmitic acid and Hexadecanoic acid, Betaine and Glycine betaine.
- **Ambiguous link:** Creatinine appears twice in `a.tsv` (a13, a14), so it links to b13 twice.
- **Case-only name pair:** `Co` (cobalt) in `a.tsv` and `CO` (carbon monoxide) in `b.tsv` differ only by case. It was meant to show a withheld name match, but in the recorded run the engine resolved both names to the same node (RM:0051008), so they form an ordinary node link instead. That wrong link is kept as recorded: it is what the engine did.
- **Review entry:** a21 Taurine carries the KEGG code C00031, which is glucose. KEGG is declared only by `a`, so its codes are compared with the name results in the review queue. a24 Tryptophan carries its correct KEGG code (C00078) for contrast.
- **Unresolved rows:** `###` in `a.tsv` and `???` in `b.tsv` are placeholder names with no meaning. Made-up words were tried first, but the engine resolves almost any word to some node; only punctuation-only names came back unresolved.
- **One-sided rows:** Caffeine is only in `b.tsv`.

## Recording

`recording/` holds one real run of this example against the hosted BioMapper API, made with `scripts/record_harmonize_run.py two_cohort`. `recording/PINS.md` gives the biomapper version, the report's pins, the date, the command and the git SHA. The replay backend reads it when `BIOMAPPER_HARMONIZE_REPLAY_DIR` points at `data/harmonize_examples`.
