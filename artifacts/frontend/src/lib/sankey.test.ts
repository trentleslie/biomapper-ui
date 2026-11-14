import { describe, expect, it } from "vitest";
import { buildSankeyData, type SankeyData } from "./sankey";
import type { MappingResult, MappingSummary } from "../types/mapping";

function res(tier: string, identifiers: Record<string, string[]>): MappingResult {
  return {
    name: `n-${Math.random()}`,
    resolved: true,
    confidenceTier: tier,
    identifiers,
  } as unknown as MappingResult;
}

const summary: MappingSummary = {
  totalRows: 2,
  uniqueNames: 2,
  resolved: 2,
  resolvedRate: 1,
  highQualityRate: 0.5,
  confidenceTierDistribution: { high: 1, medium: 0, low: 1, unknown: 0 },
  vocabularyCoverage: {},
};

const vocabIds = (d: SankeyData) => d.nodes.filter(n => n.id.startsWith("vocab_")).map(n => n.id);
const results = [
  res("high", { HMDB: ["1"], CHEBI: ["2"], KEGG: ["3"] }),
  res("low", { hmdb: ["4"] }),
];

describe("buildSankeyData vocabulary layer", () => {
  it("draws only the selected vocabularies", () => {
    const d = buildSankeyData(summary, results, true, new Set(["hmdb", "chebi"]));
    expect(vocabIds(d).sort()).toEqual(["vocab_CHEBI", "vocab_HMDB"]);
    expect(d.links.some(l => l.target.toLowerCase() === "vocab_kegg")).toBe(false);
  });

  it("falls back to all present when nothing is selected", () => {
    expect(vocabIds(buildSankeyData(summary, results, true, new Set())).length).toBe(3);
    expect(vocabIds(buildSankeyData(summary, results, true)).length).toBe(3);
  });

  it("merges prefixes that differ only by case", () => {
    const d = buildSankeyData(summary, results, true, new Set(["hmdb"]));
    expect(vocabIds(d)).toEqual(["vocab_HMDB"]);
    const total = d.links.filter(l => l.target === "vocab_HMDB").reduce((a, l) => a + l.value, 0);
    expect(total).toBe(2);
  });

  it("omits a selected vocabulary that has no hits", () => {
    const d = buildSankeyData(summary, results, true, new Set(["hmdb", "drugbank"]));
    expect(vocabIds(d)).toEqual(["vocab_HMDB"]);
  });

  it("keeps a selected CURIE prefix whose mapper key is a short name", () => {
    // Real keys from python-api services/mapper.py _process_result.
    const real = [
      res("high", { hmdb: ["1"], pubchem: ["2"], kegg: ["3"], refmet: ["4"], lipidmaps: ["5"], chembl: ["6"] }),
    ];
    const selected = new Set(["pubchem.compound", "kegg.compound", "rm", "lm", "chembl.compound"]);
    expect(vocabIds(buildSankeyData(summary, real, true, selected)).sort()).toEqual([
      "vocab_CHEMBL", "vocab_KEGG", "vocab_LIPIDMAPS", "vocab_PUBCHEM", "vocab_REFMET",
    ]);
  });

  it("keeps the 'Not scored' label for the unscored tier", () => {
    const s = { ...summary, confidenceTierDistribution: { high: 0, medium: 0, low: 0, unknown: 2 } };
    const d = buildSankeyData(s, [res("unknown", { hmdb: ["1"] })], false);
    expect(d.nodes.find(n => n.id === "unknown_tier")?.label).toBe("Not scored (2)");
  });
});
