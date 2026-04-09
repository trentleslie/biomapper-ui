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
  high:    '#22c55e',  // green
  medium:  '#f59e0b',  // amber
  low:     '#f97316',  // orange
  unknown: '#9ca3af',  // gray
};

export function buildSankeyData(
  summary: MappingSummary,
  results: MappingResult[],
  includeVocabLayer: boolean = false
): SankeyData {
  const unresolved = summary.uniqueNames - summary.resolved;
  const { high, medium, low, unknown: unknownCount } = summary.confidenceTierDistribution;

  const nodes: SankeyNode[] = [
    { id: 'input',      label: `Input (${summary.uniqueNames})`,   color: '#6b7280' },
    { id: 'resolved',   label: `Resolved (${summary.resolved})`,   color: '#14b8a6' },
    { id: 'unresolved', label: `Unresolved (${unresolved})`,       color: '#ef4444' },
    { id: 'high',       label: `High (${high})`,                   color: TIER_COLORS.high },
    { id: 'medium',     label: `Medium (${medium})`,               color: TIER_COLORS.medium },
    { id: 'low',        label: `Low (${low})`,                     color: TIER_COLORS.low },
    { id: 'unknown_tier', label: `Unknown (${unknownCount})`,      color: TIER_COLORS.unknown },
  ];

  const links: SankeyLink[] = [
    // Layer 1: resolution
    { source: 'input',    target: 'resolved',     value: summary.resolved },
    { source: 'input',    target: 'unresolved',   value: Math.max(unresolved, 1) }, // nivo requires value > 0
    // Layer 2: confidence tiers (from resolved only)
    { source: 'resolved', target: 'high',         value: high || 1 },
    { source: 'resolved', target: 'medium',       value: medium || 1 },
    { source: 'resolved', target: 'low',          value: low || 1 },
    { source: 'resolved', target: 'unknown_tier', value: unknownCount || 1 },
  ];

  if (includeVocabLayer && results.length > 0) {
    const vocabByTier: Record<string, Record<string, number>> = {};

    for (const result of results) {
      if (!result.resolved) continue;
      const tier = result.confidenceTier || 'unknown';
      if (tier !== 'high' && tier !== 'medium') continue;

      if (result.identifiers) {
        for (const [vocab, ids] of Object.entries(result.identifiers)) {
          if (!ids || ids.length === 0) continue;
          if (!vocabByTier[tier]) vocabByTier[tier] = {};
          vocabByTier[tier][vocab] = (vocabByTier[tier][vocab] || 0) + 1;
        }
      }
    }

    const vocabTotals: Record<string, number> = {};
    for (const tierCounts of Object.values(vocabByTier)) {
      for (const [vocab, count] of Object.entries(tierCounts)) {
        vocabTotals[vocab] = (vocabTotals[vocab] || 0) + count;
      }
    }
    const topVocabs = Object.entries(vocabTotals)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([vocab]) => vocab);

    for (const vocab of topVocabs) {
      nodes.push({ id: `vocab_${vocab}`, label: vocab, color: '#3b82f6' });
    }
    for (const [tier, counts] of Object.entries(vocabByTier)) {
      const tierId = tier === 'unknown' ? 'unknown_tier' : tier;
      for (const [vocab, count] of Object.entries(counts)) {
        if (!topVocabs.includes(vocab)) continue;
        links.push({ source: tierId, target: `vocab_${vocab}`, value: count });
      }
    }
  }

  return { nodes, links };
}
