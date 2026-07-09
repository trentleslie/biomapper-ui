import Papa from "papaparse";
import type { GroundTruth } from "./benchmark-api";

export interface ParsedCsv {
  columns: string[];
  rows: Record<string, string>[];
}

export function parseCsv(text: string): ParsedCsv {
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });
  const rows = (result.data ?? []).filter((r) => Object.keys(r).length > 0);
  const columns = result.meta.fields ?? (rows[0] ? Object.keys(rows[0]) : []);
  return { columns, rows };
}

export interface ColumnMapping {
  nameColumn: string;
  /** vocabulary -> source column name */
  vocabColumns: Record<string, string>;
}

/** Known benchmark vocabularies offered in the column-mapping UI. */
export const VOCABULARIES = [
  "hmdb",
  "chebi",
  "pubchem",
  "refmet",
  "lipidmaps",
  "kegg",
] as const;

/** Auto-detect the name column and any gt_<vocab> columns from headers. */
export function autoDetectMapping(columns: string[]): ColumnMapping {
  const lower = (c: string) => c.trim().toLowerCase();
  const nameColumn =
    columns.find((c) => /^(name|compound_name|compound|metabolite)$/.test(lower(c))) ??
    columns[0] ??
    "";
  const vocabColumns: Record<string, string> = {};
  for (const c of columns) {
    const m = lower(c).match(/^gt[_-]?([a-z]+)$/);
    if (m && (VOCABULARIES as readonly string[]).includes(m[1])) {
      vocabColumns[m[1]] = c;
    }
  }
  return { nameColumn, vocabColumns };
}

export interface BuildResult {
  names: string[];
  groundTruth: GroundTruth;
  vocabularies: string[];
  duplicatesMerged: number;
}

/**
 * Build the benchmark payload from parsed rows + a column mapping.
 * Duplicate names union their non-empty GT cells (plan I1). ';'-separated multi-ids.
 */
export function buildPayload(rows: Record<string, string>[], mapping: ColumnMapping): BuildResult {
  const gt: GroundTruth = {};
  const order: string[] = [];
  let duplicates = 0;
  const vocabs = Object.keys(mapping.vocabColumns);

  for (const row of rows) {
    const name = (row[mapping.nameColumn] ?? "").trim();
    if (!name) continue;
    if (!gt[name]) {
      gt[name] = {};
      order.push(name);
    } else {
      duplicates += 1;
    }
    for (const vocab of vocabs) {
      const raw = (row[mapping.vocabColumns[vocab]] ?? "").trim();
      if (!raw) continue;
      const ids = raw.split(";").map((s) => s.trim()).filter(Boolean);
      const existing = new Set(gt[name][vocab] ?? []);
      for (const id of ids) existing.add(id);
      gt[name][vocab] = Array.from(existing);
    }
  }

  return { names: order, groundTruth: gt, vocabularies: vocabs, duplicatesMerged: duplicates };
}

/** RFC-4180 quote + spreadsheet formula-injection guard (plan RC-13). */
export function escapeCsvField(value: string): string {
  let v = value ?? "";
  if (/^[=+\-@]/.test(v)) v = "\t" + v;
  if (/[",\n\r]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
  return v;
}
