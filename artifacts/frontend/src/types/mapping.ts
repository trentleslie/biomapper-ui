import { MappingResultItem } from "@workspace/api-client-react";

export interface MappingSummary {
  totalRows: number;
  uniqueNames: number;
  resolved: number;
  resolvedRate: number;
  highQualityRate: number;
  confidenceTierDistribution: {
    high: number;
    medium: number;
    low: number;
    unknown: number;
  };
  vocabularyCoverage: Record<string, number>;
}

export interface MappingResult extends MappingResultItem {
  kg_equivalent_ids?: string[];
}
