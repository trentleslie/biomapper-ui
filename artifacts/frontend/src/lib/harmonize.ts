// Pure helpers for the harmonization workbench: run states, progress, item descriptions, export plumbing and
// the error text the API sends. Nothing here touches React, so it is unit-tested on its own.

import type { HarmonizeItem, HarmonizeRunStatus } from "@workspace/api-client-react";

// ---------------------------------------------------------------------------
// Run states
// ---------------------------------------------------------------------------

export type RunState = HarmonizeRunStatus["state"];

/** Every state the package (or this app, for "unknown") can report, in words. */
export const STATE_LABELS: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  complete: "Complete",
  partial: "Partial",
  stalled: "Stalled",
  paused: "Paused",
  expired: "Expired",
  cancelled: "Cancelled",
  failed: "Failed",
  owned_elsewhere: "Owned elsewhere",
  unknown: "Unknown",
};

/** A state in words; an unexpected value is shown as written rather than blank. */
export function stateLabel(state: string | null | undefined): string {
  if (!state) return "Unknown";
  return STATE_LABELS[state] ?? state.replace(/_/g, " ");
}

export type StateTone = "success" | "warning" | "danger" | "info" | "neutral";

export function stateTone(state: string | null | undefined): StateTone {
  switch (state) {
    case "complete":
      return "success";
    case "partial":
    case "stalled":
    case "paused":
    case "expired":
    case "owned_elsewhere":
      return "warning";
    case "failed":
      return "danger";
    case "queued":
    case "running":
      return "info";
    default:
      return "neutral";
  }
}

/** Results (report, items, flags, exports) exist only for these states. */
export function hasResults(state: string | null | undefined): boolean {
  return state === "complete" || state === "partial";
}

/** States in which the run is still moving on its own and worth polling. */
export function isActive(state: string | null | undefined): boolean {
  return state === "queued" || state === "running";
}

export function canCancel(run: Pick<HarmonizeRunStatus, "state" | "kind">): boolean {
  if (run.kind === "harmonize_results") return false;
  return ["queued", "running", "paused", "stalled"].includes(run.state);
}

export function canResume(run: Pick<HarmonizeRunStatus, "state" | "kind">): boolean {
  if (run.kind === "harmonize_results") return false;
  return ["cancelled", "paused", "stalled", "expired"].includes(run.state);
}

export const KIND_LABELS: Record<string, string> = {
  harmonize_cohorts: "Two cohorts",
  harmonize_many: "Many cohorts",
  harmonize_results: "Finished jobs",
};

export function kindLabel(kind: string | null | undefined): string {
  return (kind && KIND_LABELS[kind]) || "Run";
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export const ARM_LABELS: Record<string, string> = {
  names_only: "Names only",
  identifier: "Identifier",
  review: "Review",
};

export function armLabel(arm: string | null | undefined): string {
  if (!arm) return "Arm";
  return ARM_LABELS[arm] ?? arm.replace(/_/g, " ");
}

export interface ProgressView {
  arm: string;
  armLabel: string;
  done: number;
  total: number;
  /** 0 to 100, never above 100. */
  percent: number;
  /** e.g. "12 of 30 entities". */
  text: string;
}

/**
 * The current arm's progress. Only progress.entitiesDone out of progress.entitiesTotal is used: the job-wide
 * entitiesMapped and entitiesTotal can disagree (mapped above total) and are never shown as a fraction.
 */
export function progressView(progress: HarmonizeRunStatus["progress"] | null | undefined): ProgressView | null {
  if (!progress) return null;
  const total = Math.max(0, progress.entitiesTotal ?? 0);
  const done = Math.max(0, Math.min(progress.entitiesDone ?? 0, total));
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return {
    arm: progress.arm,
    armLabel: armLabel(progress.arm),
    done,
    total,
    percent,
    text: `${done.toLocaleString()} of ${total.toLocaleString()} entities`,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The message the API wrote, as written. FastAPI sends `{"detail": "..."}`; a validation error sends a list.
 * Falls back to the error's own message without the client's "HTTP 400 Bad Request:" prefix.
 */
export function apiErrorMessage(error: unknown): string {
  if (!error) return "Something went wrong.";
  const data = (error as { data?: unknown }).data;
  if (data && typeof data === "object") {
    const detail = (data as { detail?: unknown }).detail;
    if (typeof detail === "string" && detail.trim()) return detail;
    if (Array.isArray(detail) && detail.length > 0) {
      const first = detail[0] as { msg?: unknown; loc?: unknown };
      if (typeof first?.msg === "string") {
        const loc = Array.isArray(first.loc) ? first.loc.join(".") : "";
        return loc ? `${loc}: ${first.msg}` : first.msg;
      }
    }
  }
  if (typeof data === "string" && data.trim()) return data.trim();
  const message = (error as { message?: unknown }).message;
  if (typeof message === "string" && message.trim()) {
    return message.replace(/^HTTP \d{3}[^:]*:\s*/, "");
  }
  return "Something went wrong.";
}

export function errorStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

// ---------------------------------------------------------------------------
// Cohort setup
// ---------------------------------------------------------------------------

export const MAX_COHORT_BYTES = 50 * 1024 * 1024;
export const MAX_COHORTS = 12;

/** The package's own message for an oversized file (Python repr quoting of the name). */
export function oversizeMessage(filename: string): string {
  const quoted = filename.includes("'") && !filename.includes('"') ? `"${filename}"` : `'${filename}'`;
  return `${quoted} is larger than the 50 MB limit.`;
}

/** A label that passes the cohort label rule (letters, digits, '.', '-', '_'), from a file name. */
export function labelFromFilename(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "");
  const cleaned = stem.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "cohort";
}

/** The column most likely to hold names, or the first column. */
export function guessNameColumn(columns: string[]): string {
  const wanted = ["name", "analyte", "analyte_name", "metabolite", "compound", "biochemical", "label"];
  for (const w of wanted) {
    const hit = columns.find((c) => c.trim().toLowerCase() === w);
    if (hit) return hit;
  }
  return columns.find((c) => /name/i.test(c)) ?? columns[0] ?? "";
}

/** The column most likely to be a row key, or null. */
export function guessKeyColumn(columns: string[]): string | null {
  const wanted = ["id", "key", "row_id", "sample_id", "analyte_id", "comp_id"];
  for (const w of wanted) {
    const hit = columns.find((c) => c.trim().toLowerCase() === w);
    if (hit) return hit;
  }
  return null;
}

/** Vocabularies recognised from column names, e.g. a column "hmdb_id" under HMDB. Columns per vocabulary. */
export function guessVocabularies(columns: string[], known: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const column of columns) {
    const norm = column.trim().toLowerCase().replace(/[^a-z0-9.]+/g, "_");
    for (const vocab of known) {
      const v = vocab.toLowerCase();
      if (norm === v || norm === `${v}_id` || norm === `${v}_ids` || norm === `${v}id` || norm.startsWith(`${v}_`)) {
        (out[vocab] ??= []).push(column);
        break;
      }
    }
  }
  return out;
}

/** Vocabularies with at least one column, in a stable order, as the spec wants them. */
export function cleanVocabularies(vocabs: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, cols] of Object.entries(vocabs)) {
    const key = name.trim();
    if (key && cols.length > 0) out[key] = [...cols];
  }
  return out;
}

/** Common entity types first (the package's aliases), then the rest of the discovery list. */
export const COMMON_ENTITY_TYPES: { type: string; label: string }[] = [
  { type: "biolink:SmallMolecule", label: "Metabolites" },
  { type: "biolink:Protein", label: "Proteins" },
  { type: "biolink:Gene", label: "Genes" },
  { type: "biolink:ClinicalMeasurement", label: "Clinical labs" },
];

export function entityLabel(entity: string | null | undefined): string {
  if (!entity) return "Entity not given";
  const alias: Record<string, string> = { metabolites: "biolink:SmallMolecule", proteins: "biolink:Protein", genes: "biolink:Gene", labs: "biolink:ClinicalMeasurement" };
  const type = alias[entity.toLowerCase()] ?? entity;
  const common = COMMON_ENTITY_TYPES.find((c) => c.type === type);
  return common ? `${common.label} (${entity})` : entity;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export const ITEM_KIND_LABELS: Record<string, string> = {
  link: "Link",
  group: "Group",
  review: "Review",
  unresolved: "Unresolved",
};

const ORIGIN_LABELS: Record<string, string> = {
  links: "Link",
  groups: "Group",
  review_queue: "One-sided identifier check",
  possible_missed: "Possible miss",
  name_match_withheld: "Withheld name match",
  withheld: "Withheld name match",
  cross_node: "Cross-node review",
  id_check_review: "Identifier did not confirm node",
  unresolved_rows: "Unresolved row",
  unresolved: "Unresolved row",
  errored_rows: "Errored row",
  errors: "Errored row",
  not_grouped: "Not grouped",
};

const BUCKET_LABELS: Record<string, string> = {
  no_node: "No node",
  unresolved: "Unresolved",
  errored: "Errored",
};

export const BASIS_LABELS: Record<string, string> = {
  node: "Same node",
  identifier: "Shared identifier",
  name_exact: "Same name",
  name_casefold: "Same name, ignoring case",
};

export function basisLabel(basis: unknown): string {
  return typeof basis === "string" ? BASIS_LABELS[basis] ?? basis : "";
}

export interface ItemBadge {
  text: string;
  tone: StateTone;
}

export interface ItemDescription {
  /** What the item is, e.g. "Ambiguous link" or "Group with multiplicity". */
  title: string;
  badges: ItemBadge[];
  /** One line of the detail that matters most. */
  facts: string[];
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** How one item reads in the table and the drawer. */
export function describeItem(item: Pick<HarmonizeItem, "kind" | "detail" | "members">): ItemDescription {
  const d = (item.detail ?? {}) as Record<string, unknown>;
  const origin = typeof d.origin === "string" ? d.origin : "";
  const badges: ItemBadge[] = [];
  const facts: string[] = [];

  if (item.kind === "link") {
    const ambiguous = d.ambiguous === true;
    badges.push(ambiguous ? { text: "Ambiguous", tone: "warning" } : { text: "One-to-one", tone: "success" });
    const basis = basisLabel(d.basis);
    if (basis) facts.push(`Basis: ${basis}`);
    const a = num(d.aPartners);
    const b = num(d.bPartners);
    if (a !== null && b !== null) facts.push(`Partners: A ${a}, B ${b}`);
    return { title: ambiguous ? "Ambiguous link" : "One-to-one link", badges, facts };
  }

  if (item.kind === "group") {
    if (d.multiplicity === true) badges.push({ text: "Multiplicity", tone: "warning" });
    if (d.broad === true) badges.push({ text: "Broad", tone: "warning" });
    if (d.clean === true) badges.push({ text: "Clean", tone: "success" });
    const cohorts = Array.isArray(d.cohorts) ? d.cohorts.length : new Set(item.members.map((m) => m.cohort)).size;
    facts.push(`${cohorts} ${cohorts === 1 ? "cohort" : "cohorts"}, ${item.members.length} ${item.members.length === 1 ? "row" : "rows"}`);
    if (typeof d.node === "string") facts.push(`Node ${d.node}`);
    const title = d.multiplicity === true ? "Group with multiplicity" : d.broad === true ? "Broad group" : "Clean group";
    return { title, badges, facts };
  }

  if (item.kind === "review") {
    const title = ORIGIN_LABELS[origin] ?? ORIGIN_LABELS[String(d.reason ?? "")] ?? "Review entry";
    if (origin === "review_queue") {
      if (typeof d.vocabulary === "string" && typeof d.code === "string") facts.push(`${d.vocabulary} ${d.code}`);
      if (typeof d.status === "string") badges.push({ text: d.status.replace(/_/g, " "), tone: d.status === "agree" ? "success" : "warning" });
    } else if (origin === "cross_node") {
      if (typeof d.nodeA === "string" && typeof d.nodeB === "string") facts.push(`${d.nodeA} and ${d.nodeB}`);
      const pairs = num(d.nRowPairs);
      if (pairs !== null) facts.push(`${pairs} row ${pairs === 1 ? "pair" : "pairs"}`);
    } else if (origin === "id_check_review") {
      const check = (d.check ?? {}) as Record<string, unknown>;
      if (typeof check.status === "string") badges.push({ text: check.status.replace(/_/g, " "), tone: "warning" });
      if (Array.isArray(check.declared) && check.declared.length) facts.push(`Declared ${check.declared.join(", ")}`);
      if (typeof d.node === "string") facts.push(`Node ${d.node}`);
    } else if (origin === "possible_missed") {
      if (Array.isArray(d.reasons) && d.reasons.length) facts.push(`Signals: ${d.reasons.map(String).join(", ").replace(/_/g, " ")}`);
      if (d.resolved === false) facts.push("Did not resolve");
    }
    return { title, badges, facts };
  }

  // unresolved
  const bucket = typeof d.bucket === "string" ? d.bucket : "unresolved";
  badges.push({ text: BUCKET_LABELS[bucket] ?? bucket, tone: bucket === "errored" ? "danger" : "neutral" });
  if (typeof d.error === "string" && d.error) facts.push(d.error);
  const title = bucket === "errored" ? "Errored row" : bucket === "no_node" ? "Row with no node" : "Unresolved row";
  return { title, badges, facts };
}

/** The report list an item came from, in words. */
export function originLabel(origin: unknown): string {
  return typeof origin === "string" ? ORIGIN_LABELS[origin] ?? origin.replace(/_/g, " ") : "";
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const EXPORT_TABLES = ["links", "groups", "review", "unresolved"] as const;
export type ExportTable = (typeof EXPORT_TABLES)[number] | "eitl_pairs";
export const EXPORT_FORMATS = ["csv", "tsv", "json"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export function exportUrl(jobId: string, table: ExportTable, format: ExportFormat): string {
  const q = new URLSearchParams({ table, format });
  return `/api/harmonize/runs/${encodeURIComponent(jobId)}/export?${q.toString()}`;
}

/** The file name from a Content-Disposition header, or a fallback. */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      /* fall through */
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i.exec(header);
  const name = plain ? (plain[1] ?? plain[2] ?? "").trim() : "";
  return name || fallback;
}

/** The X-Harmonize-Skipped-One-Sided header as a number, or null when absent or unreadable. */
export function skippedFromHeader(header: string | null): number | null {
  if (header === null || header.trim() === "") return null;
  const n = Number(header);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export interface ExportResult {
  filename: string;
  blob: Blob;
  skipped: number | null;
}

/**
 * Fetch one export with a raw fetch, so the response headers (file name, skipped count) can be read; the
 * generated client hides them. A non-2xx answer throws with the API's message as written.
 */
export async function fetchExport(jobId: string, table: ExportTable, format: ExportFormat): Promise<ExportResult> {
  const response = await fetch(exportUrl(jobId, table, format), { credentials: "same-origin" });
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail = apiErrorMessage({ data: body });
    } catch {
      detail = `The download failed (HTTP ${response.status}).`;
    }
    const err = new Error(detail) as Error & { status: number };
    err.status = response.status;
    throw err;
  }
  const blob = await response.blob();
  return {
    blob,
    filename: filenameFromDisposition(response.headers.get("content-disposition"), `${table}.${format}`),
    skipped: skippedFromHeader(response.headers.get("x-harmonize-skipped-one-sided")),
  };
}

/** Hand a fetched file to the browser as a download. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "Time not recorded";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}
