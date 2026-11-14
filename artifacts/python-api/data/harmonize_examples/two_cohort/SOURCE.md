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

## Known identifier notes

The identifiers in these files were written from knowledge of the public HMDB and KEGG vocabularies and checked only against the recorded run in `recording/`. The rows below declare an identifier that the recording does not confirm against the row's names-only node: the identifier arm chose a different node. `tests/test_harmonize_examples.py` fails if a row like this is missing from this list.

- **3-Hydroxybutyric acid (a18) and beta-Hydroxybutyrate (b17)** declare HMDB0000011, which is the (R)-form, (R)-3-hydroxybutyric acid. The generic name's code is HMDB0000357. The names-only arm chooses RM:0153056 (HMDB0000357, no stereo); the identifier arm resolves HMDB0000011 to RM:0152271, the (R)-enantiomer. The two arms choose different nodes, a useful demonstration of why the identifier arm matters. Both rows still link to each other in both arms.
- **Glucose (a01) and D-Glucose (b01)** declare HMDB0000122. The names-only node RM:0135901 carries HMDB0304632, not HMDB0000122; the identifier arm resolves the code to a D-glucose node (HMDB:HMDB0000122).
- **Betaine (a22) and Glycine betaine (b21)** declare HMDB0000043. The names-only node RM:0135869 has no HMDB code; the identifier arm resolves the code to RM:0204298, the same skeleton in a different protonation state.

This report kind has no per-row identifier check, so these differences show only by comparing the two arms' `mappings`, not as review items.

## Recording

`recording/` holds one real run of this example against the hosted BioMapper API, made with `scripts/record_harmonize_run.py two_cohort`. `recording/PINS.md` gives the biomapper version, the report's pins, the date, the command and the git SHA. The replay backend reads it when `BIOMAPPER_HARMONIZE_REPLAY_DIR` points at `data/harmonize_examples`.
