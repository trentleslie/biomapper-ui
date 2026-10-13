// Plain-language definitions of the results columns, shared by the column tooltips and the
// demo "How to read these results" guide so the two can never drift apart.
//
// Source of truth for the numbers below: the biomapper client
// (biomapper/models.py, MappingResult.confidence_tier) and the biomapper2 Kestrel annotators.
// If the tier cutoffs change upstream, change them here.

export const TIER_HIGH_MIN = 2.0;
export const TIER_MEDIUM_MIN = 1.0;

export const EXPLAINERS = {
  name: "The compound name exactly as it appeared in the input. It is the only thing sent to BioMapper.",
  primaryCurie:
    "The identifier BioMapper chose for this name, written as PREFIX:ID (for example CHEBI:17234 or HMDB:HMDB0000122). The prefix names the database.",
  score:
    "How strongly the knowledge-graph search matched the name, on a scale of roughly 0 to 5 (higher is a closer text match). It is the best score among the identifiers returned. It is a search-relevance signal, not a probability of being correct.",
  tier: `A bucket based on the score: High is ${TIER_HIGH_MIN.toFixed(1)} or more, Medium is ${TIER_MEDIUM_MIN.toFixed(1)} to ${TIER_HIGH_MIN.toFixed(1)}, Low is below ${TIER_MEDIUM_MIN.toFixed(1)}. Unknown means the match came from a curated source (such as RefMet or LIPID MAPS) that does not produce a search score, which is often a good match rather than a bad one. Unresolved means nothing was found.`,
  highQuality: `Share of unique names whose tier is High or Medium (score ${TIER_MEDIUM_MIN.toFixed(1)} or more). This measures search strength, not verified accuracy.`,
  vocabColumns:
    "Cross-references to other databases (HMDB, ChEBI, PubChem, RefMet, LIPID MAPS, KEGG and more) for the same compound. Click a row to see all of them.",
  needsReview:
    "Rows worth a human look: nothing found, a Low or Unknown tier, or a conflict between RefMet and ChEBI that BioMapper flagged.",
} as const;

export const REVIEW_REASONS = {
  unresolved: "No match found",
  divergent_refmet: "RefMet ChEBI conflict (structure differs)",
  conflict_no_structure: "RefMet ChEBI conflict (no structure to adjudicate)",
  unknown: "No search score (curated-source match)",
  low: "Low search score",
} as const;

// Same rule as the Needs Review table, so downloads and the page agree on which rows are flagged.
export function rowNeedsReview(row: {
  needsReview?: boolean;
  resolved: boolean;
  confidenceTier?: string | null;
}): boolean {
  return !!row.needsReview || !row.resolved || row.confidenceTier === "unknown" || row.confidenceTier === "low";
}

export function reviewReason(row: {
  resolved: boolean;
  confidenceTier?: string | null;
  chosenKgIdReview?: string | null;
}): string {
  if (!row.resolved) return REVIEW_REASONS.unresolved;
  if (row.chosenKgIdReview === "divergent_refmet") return REVIEW_REASONS.divergent_refmet;
  if (row.chosenKgIdReview === "conflict_no_structure") return REVIEW_REASONS.conflict_no_structure;
  if (!row.confidenceTier || row.confidenceTier === "unknown") return REVIEW_REASONS.unknown;
  return REVIEW_REASONS.low;
}
