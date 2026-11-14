// The upload page writes the selected vocabularies to the `ontologies` URL param as
// lowercased CURIE prefixes from /vocabularies (PUBCHEM.COMPOUND, RM, LM, ...), while
// python-api services/mapper.py keys MappingResult.identifiers by short names (pubchem,
// refmet, lipidmaps, ...). Compare the two only through identifierKey().
const PREFIX_TO_IDENTIFIER_KEY: Record<string, string> = {
  "pubchem.compound": "pubchem",
  "kegg.compound": "kegg",
  "chembl.compound": "chembl",
  lm: "lipidmaps",
  rm: "refmet",
};

/** Lowercased MappingResult.identifiers key for a CURIE prefix or an identifiers key. */
export function identifierKey(vocab: string): string {
  const lower = vocab.toLowerCase();
  return PREFIX_TO_IDENTIFIER_KEY[lower] ?? lower;
}

/** identifiers keys for a selection of vocabularies; null when nothing is selected (show all). */
export function identifierKeysFor(selected: ReadonlySet<string> | undefined): Set<string> | null {
  if (!selected || selected.size === 0) return null;
  return new Set(Array.from(selected, identifierKey));
}
