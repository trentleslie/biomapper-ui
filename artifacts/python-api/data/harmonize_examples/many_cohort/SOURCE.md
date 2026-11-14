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

## Known identifier notes

The identifiers in these files were written from knowledge of the public HMDB and KEGG vocabularies and checked only against the recorded run in `recording/`. The rows below declare an identifier that the recording does not confirm against the row's names-only node: the identifier arm chose a different node. `tests/test_harmonize_examples.py` fails if a row like this is missing from this list.

- **3-Hydroxybutyric acid (e12)** declares HMDB0000011, which is the (R)-form, (R)-3-hydroxybutyric acid. The generic name's code is HMDB0000357. The names-only arm chooses RM:0153056 (HMDB0000357, no stereo) and records the row's identifier check as `not_confirmed` (an `id_check_review` entry); the identifier arm resolves HMDB0000011 to RM:0152271, the (R)-enantiomer. The two arms choose different nodes, a useful demonstration of why the identifier arm matters.
- **Glucose and D-Glucose (a01, b01, c01, d01, e01)** declare HMDB0000122. The names-only node RM:0135901 carries HMDB0304632, not HMDB0000122, so a01, b01 and e01 are `not_confirmed` `id_check_review` entries (c01 and d01 are confirmed through their KEGG code); the identifier arm resolves the code to a D-glucose node (HMDB:HMDB0000122).
- **Betaine (c14) and Glycine betaine (d11)** declare HMDB0000043. The names-only node RM:0135869 has no HMDB code; the identifier arm resolves the code to RM:0204298, the same skeleton in a different protonation state. Their KEGG code matched, so the names-only arm does not flag them.
- **Creatinine (c06)** carries the deliberately wrong HMDB0000294 (urea). In the names-only arm it reads as confirmed, because its KEGG code (C00791) matched the creatinine node. The identifier arm is where it shows: the code moves c06 to the urea node RM:0117395, into the urea group, with a `cross_node` review entry between the creatinine and urea nodes.

## Recording

`recording/` holds one real run of this example against the hosted BioMapper API, made with `scripts/record_harmonize_run.py many_cohort`. `recording/PINS.md` gives the biomapper version, the report's pins, the date, the command and the git SHA. The replay backend reads it when `BIOMAPPER_HARMONIZE_REPLAY_DIR` points at `data/harmonize_examples`.
