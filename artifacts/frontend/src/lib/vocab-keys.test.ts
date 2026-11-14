import { describe, expect, it } from "vitest";
import { identifierKey, identifierKeysFor } from "./vocab-keys";

// The upload page writes lowercased CURIE prefixes from /vocabularies into `ontologies`;
// python-api services/mapper.py keys MappingResult.identifiers by these short names.
const MAPPER_KEYS = ["hmdb", "chebi", "pubchem", "refmet", "lipidmaps", "kegg", "umls", "mesh", "unii", "chembl"];

describe("identifierKey", () => {
  it.each([
    ["pubchem.compound", "pubchem"],
    ["PUBCHEM.COMPOUND", "pubchem"],
    ["kegg.compound", "kegg"],
    ["chembl.compound", "chembl"],
    ["lm", "lipidmaps"],
    ["rm", "refmet"],
    ["hmdb", "hmdb"],
    ["CHEBI", "chebi"],
    ["kegg", "kegg"],
    ["drugbank", "drugbank"],
  ])("maps %s to %s", (prefix, key) => {
    expect(identifierKey(prefix)).toBe(key);
  });

  it("leaves every mapper key unchanged", () => {
    for (const k of MAPPER_KEYS) expect(identifierKey(k)).toBe(k);
  });
});

describe("identifierKeysFor", () => {
  it("normalizes a selection of CURIE prefixes", () => {
    expect(identifierKeysFor(new Set(["pubchem.compound", "rm", "hmdb"]))).toEqual(
      new Set(["pubchem", "refmet", "hmdb"]),
    );
  });

  it("returns null for an empty or missing selection", () => {
    expect(identifierKeysFor(new Set())).toBeNull();
    expect(identifierKeysFor(undefined)).toBeNull();
  });
});
