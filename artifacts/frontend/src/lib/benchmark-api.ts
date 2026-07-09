import { customFetch } from "@workspace/api-client-react";

// Ground truth: name -> vocabulary -> list of raw ids.
export type GroundTruth = Record<string, Record<string, string[]>>;

export interface BenchmarkRequestBody {
  names: string[];
  groundTruth: GroundTruth;
  vocabularies?: string[];
  datasetName?: string;
}

export interface CorpusMetric {
  vocabulary: string;
  n: number;
  map: number;
  mrr: number;
  hitAt1: number;
  hitAt5: number;
  hitAtInf: number;
  meanRecallAt5: number;
  meanRecallAtInf: number;
  meanCandidates: number;
  normalizationLift: number;
  runErrorCount: number;
  orderAsserted: boolean;
  decisionLabel: string;
  diagnostics: Record<string, number>;
}

export interface BenchmarkRun {
  run_id: string;
  display_name?: string | null;
  dataset_name?: string | null;
  status: "pending" | "processing" | "complete" | "error" | "interrupted";
  error_message?: string | null;
  sdk_version?: string | null;
  env: string;
  order_asserted: boolean;
  total: number;
  corpus_metrics?: CorpusMetric[] | null;
  input_names?: string[] | null;
  created_at: number;
  updated_at: number;
}

export interface RowLog {
  name: string;
  vocabulary: string;
  ground_truth: string;
  returned_ids: string;
  hit_ranks: string;
  category: string;
}

export interface CompareResult {
  a: BenchmarkRun;
  b: BenchmarkRun;
  mismatch: Record<string, boolean>;
}

const BASE = "/api/benchmark";

export function startBenchmark(body: BenchmarkRequestBody): Promise<{ run_id: string }> {
  return customFetch(`${BASE}/batch`, { method: "POST", body: JSON.stringify(body), responseType: "json" });
}

export function getBenchmarkResult(runId: string): Promise<BenchmarkRun> {
  return customFetch(`${BASE}/result/${runId}`, { responseType: "json" });
}

export function listBenchmarkRuns(): Promise<BenchmarkRun[]> {
  return customFetch(`${BASE}/runs`, { responseType: "json" });
}

export function getBenchmarkRun(runId: string): Promise<BenchmarkRun> {
  return customFetch(`${BASE}/runs/${runId}`, { responseType: "json" });
}

export function deleteBenchmarkRun(runId: string): Promise<{ deleted: boolean }> {
  return customFetch(`${BASE}/runs/${runId}`, { method: "DELETE", responseType: "json" });
}

export interface RowFilters {
  category?: string;
  vocabulary?: string;
  rerankable?: boolean;
  limit?: number;
}

export function getRowLogs(runId: string, filters: RowFilters = {}): Promise<RowLog[]> {
  const params = new URLSearchParams();
  if (filters.category) params.set("category", filters.category);
  if (filters.vocabulary) params.set("vocabulary", filters.vocabulary);
  if (filters.rerankable) params.set("rerankable", "true");
  if (filters.limit) params.set("limit", String(filters.limit));
  const qs = params.toString();
  return customFetch(`${BASE}/runs/${runId}/rows${qs ? `?${qs}` : ""}`, { responseType: "json" });
}

export function compareRuns(a: string, b: string): Promise<CompareResult> {
  return customFetch(`${BASE}/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`, {
    responseType: "json",
  });
}
