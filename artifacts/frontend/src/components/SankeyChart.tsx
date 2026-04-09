import { ResponsiveSankey } from '@nivo/sankey';
import { buildSankeyData } from '../lib/sankey';
import { MappingResult, MappingSummary } from '../types/mapping';

interface SankeyChartProps {
  summary: MappingSummary;
  results: MappingResult[];
  includeVocabLayer?: boolean;
}

export function SankeyChart({ summary, results, includeVocabLayer = false }: SankeyChartProps) {
  const data = buildSankeyData(summary, results, includeVocabLayer);

  return (
    <div style={{ height: 400 }} data-testid="chart-sankey-funnel">
      <ResponsiveSankey
        data={data}
        margin={{ top: 20, right: 160, bottom: 20, left: 20 }}
        align="justify"
        colors={({ id }) => data.nodes.find(n => n.id === id)?.color || '#6b7280'}
        nodeOpacity={1}
        nodeThickness={18}
        nodeInnerPadding={3}
        nodeSpacing={24}
        nodeBorderWidth={0}
        linkOpacity={0.4}
        linkHoverOpacity={0.7}
        enableLinkGradient={true}
        labelPosition="outside"
        labelOrientation="horizontal"
        labelPadding={16}
        labelTextColor={{ from: 'color', modifiers: [['darker', 1]] }}
      />
    </div>
  );
}
