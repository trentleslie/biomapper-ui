import { MappingResult, MappingSummary } from '../types/mapping';

export interface SankeyNode {
  id: string;
  label?: string;
  color?: string;
}

export interface SankeyLink {
  source: string;
  target: string;
  value: number;
}

export interface SankeyData {
  nodes: SankeyNode[];
  links: SankeyLink[];
}

const TIER_COLORS = {
  high:    '#005B33',
  medium:  '#B45309',
  low:     '#B91C1C',
  unknown: '#8892A3',
};

const ALL_NODES: SankeyNode[] = [
  { id: 'input',        color: '#8892A3' },
  { id: 'resolved',     color: '#3AC2CB' },
  { id: 'unresolved',   color: '#E21C52' },
  { id: 'high',         color: TIER_COLORS.high },
  { id: 'medium',       color: TIER_COLORS.medium },
  { id: 'low',          color: TIER_COLORS.low },
  { id: 'unknown_tier', color: TIER_COLORS.unknown },
];

export function buildSankeyData(
  summary: MappingSummary,
  results: MappingResult[],
  includeVocabLayer: boolean = false
): SankeyData {
  const unresolved = summary.uniqueNames - summary.resolved;
  const { high, medium, low, unknown: unknownCount } = summary.confidenceTierDistribution;

  const rawLinks: SankeyLink[] = [];

  // Layer 1: resolution — only include links with value > 0 (no fake data)
  if (summary.resolved > 0) {
    rawLinks.push({ source: 'input', target: 'resolved', value: summary.resolved });
  }
  if (unresolved > 0) {
    rawLinks.push({ source: 'input', target: 'unresolved', value: unresolved });
  }

  // Layer 2: confidence tiers — only include where count > 0
  if (high > 0)         rawLinks.push({ source: 'resolved', target: 'high',         value: high });
  if (medium > 0)       rawLinks.push({ source: 'resolved', target: 'medium',       value: medium });
  if (low > 0)          rawLinks.push({ source: 'resolved', target: 'low',          value: low });
  if (unknownCount > 0) rawLinks.push({ source: 'resolved', target: 'unknown_tier', value: unknownCount });

  // Only include nodes that actually appear in a link (prevents dangling nodes)
  const referencedIds = new Set(rawLinks.flatMap(l => [l.source, l.target]));
  const nodes: SankeyNode[] = ALL_NODES
    .filter(n => referencedIds.has(n.id))
    .map(n => ({
      ...n,
      label: buildLabel(n.id, summary, unresolved),
    }));

  if (includeVocabLayer && results.length > 0) {
    // Aggregate hits per (confidenceTier, vocabulary) directly from results.
    // All resolved tiers are included (high/medium/low/unknown) so the funnel
    // surfaces vocabulary coverage even for low-confidence rows.
    const vocabByTier: Record<string, Record<string, number>> = {};

    for (const result of results) {
      if (!result.resolved) continue;
      const tier = result.confidenceTier || 'unknown';
      if (!result.identifiers) continue;

      for (const [vocab, ids] of Object.entries(result.identifiers)) {
        if (!ids || ids.length === 0) continue;
        if (!vocabByTier[tier]) vocabByTier[tier] = {};
        vocabByTier[tier][vocab] = (vocabByTier[tier][vocab] || 0) + 1;
      }
    }

    const allVocabs = new Set<string>();
    for (const counts of Object.values(vocabByTier)) {
      for (const vocab of Object.keys(counts)) {
        allVocabs.add(vocab);
      }
    }

    for (const vocab of Array.from(allVocabs).sort()) {
      nodes.push({ id: `vocab_${vocab}`, label: vocab.toUpperCase(), color: '#113682' });
    }
    for (const [tier, counts] of Object.entries(vocabByTier)) {
      const tierId = tier === 'unknown' ? 'unknown_tier' : tier;
      for (const [vocab, count] of Object.entries(counts)) {
        if (count === 0) continue;
        rawLinks.push({ source: tierId, target: `vocab_${vocab}`, value: count });
      }
    }
  }

  return { nodes, links: rawLinks };
}

function buildLabel(id: string, summary: MappingSummary, unresolved: number): string {
  switch (id) {
    case 'input':        return `Input (${summary.uniqueNames})`;
    case 'resolved':     return `Resolved (${summary.resolved})`;
    case 'unresolved':   return `Unresolved (${unresolved})`;
    case 'high':         return `High (${summary.confidenceTierDistribution.high})`;
    case 'medium':       return `Medium (${summary.confidenceTierDistribution.medium})`;
    case 'low':          return `Low (${summary.confidenceTierDistribution.low})`;
    case 'unknown_tier': return `Unknown (${summary.confidenceTierDistribution.unknown})`;
    default:             return id;
  }
}
