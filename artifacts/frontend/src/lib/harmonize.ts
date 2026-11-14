// Pure helpers for the harmonization page: run states in words, progress, cohort specs, messages that must
// match the package's wording, and readers for report.json (schema_version 1). No React in here, so every
// rule is unit-tested in harmonize.test.ts.

import type { HarmonizeCohortInput, HarmonizeProgress } from "@workspace/api-client-react";

// ---------------------------------------------------------------------------
// Run kinds and states
// ---------------------------------------------------------------------------

export type RunKind = "harmonize_cohorts" | "harmonize_many" | "harmonize_results";

export const KIND_LABEL: Record<string, string> = {
  harmonize_cohorts: "Two cohorts",
  harmonize_many: "Many cohorts",
  harmonize_results: "Finished jobs",
};

export function kindLabel(kind: string | null | undefined): string {
  if (!kind) return "Unknown kind";
  return KIND_LABEL[kind] ?? kind;
}

export type Tone = "neutral" | "success" | "warning" | "danger" | "info";

interface StateInfo {
  word: string;
  tone: Tone;
  /** One sentence for the run header, written for the researcher. */
  meaning: string;
}

/** Every state the package can report, plus "unknown" (a run the job runner no longer knows). */
export const RUN_STATES: Record<string, StateInfo> = {
  queued: { word: "queued", tone: "info", meaning: "Waiting for its turn. Runs go one at a time." },
  running: { word: "running", tone: "info", meaning: "Mapping is under way. This page updates by itself." },
  complete: { word: "complete", tone: "success", meaning: "Finished. The results are below." },
  partial: {
    word: "partial",
    tone: "warning",
    meaning: "Finished, but some rows errored. They are marked as errored in the results below.",
  },
  stalled: { word: "stalled", tone: "warning", meaning: "The run stopped making progress. Resume it to continue." },
  paused: { word: "paused", tone: "warning", meaning: "The run is paused. Resume it to continue." },
  expired: { word: "expired", tone: "warning", meaning: "The run waited too long and expired. Resume it to continue." },
  cancelled: { word: "cancelled", tone: "neutral", meaning: "The run was cancelled. What was mapped is kept; resume it to continue." },
  failed: { word: "failed", tone: "danger", meaning: "The run failed. Start it again from the setup above." },
  owned_elsewhere: {
    word: "owned elsewhere",
    tone: "warning",
    meaning: "Another server process is running this job right now.",
  },
  unknown: { word: "unknown", tone: "neutral", meaning: "The job runner no longer knows this run." },
};

/** The state as a word. Never blank: a missing state reads "unknown", an unexpected one as written. */
export function stateInfo(state: string | null | undefined): StateInfo {
  if (!state) return RUN_STATES.unknown;
  return RUN_STATES[state] ?? { word: state.replace(/_/g, " "), tone: "neutral", meaning: "" };
}

export const FINISHED = new Set(["complete", "partial"]);
export const WAITING = new Set(["queued", "running"]);
const RESUMABLE = new Set(["cancelled", "paused", "stalled", "expired"]);
const CANCELLABLE = new Set(["queued", "running", "paused", "stalled", "expired"]);

export function isFinished(state: string | null | undefined): boolean {
  return !!state && FINISHED.has(state);
}

export function isWaiting(state: string | null | undefined): boolean {
  return !!state && WAITING.has(state);
}

/** A run built from finished jobs has no backend job: nothing to cancel or resume. */
export function canResume(kind: string, state: string | null | undefined): boolean {
  return kind !== "harmonize_results" && !!state && RESUMABLE.has(state);
}

export function canCancel(kind: string, state: string | null | undefined): boolean {
  return kind !== "harmonize_results" && !!state && CANCELLABLE.has(state);
}

/** How often to ask for a run's status: quickly while it moves by itself, slowly while it waits for the user. */
export function pollInterval(state: string | null | undefined): number | false {
  if (isWaiting(state)) return 2000;
  if (state && (RESUMABLE.has(state) || state === "owned_elsewhere")) return 10000;
  return false;
}

export const STAGE_LABEL: Record<string, string> = {
  queued: "Queued",
  mapping: "Mapping names",
  building: "Building links",
  capture: "Capturing review evidence",
  placing: "Writing the report",
  done: "Done",
};

export const ARM_LABEL: Record<string, string> = {
  names_only: "Names only",
  identifier: "Identifier",
  review: "Review",
};

export function armLabel(arm: string | null | undefined): string {
  if (!arm) return "Unknown arm";
  return ARM_LABEL[arm] ?? arm;
}

export interface ArmProgress {
  arm: string;
  done: number;
  total: number;
  /** 0 to 100, never more. */
  percent: number;
}

/**
 * Progress of the current arm only. The job-wide entitiesMapped and entitiesTotal are deliberately not used:
 * the package counts mappings per arm and across restarts, so mapped can exceed total.
 */
export function armProgress(progress: HarmonizeProgress | null | undefined): ArmProgress | null {
  if (!progress) return null;
  const total = Math.max(0, progress.entitiesTotal ?? 0);
  const done = Math.min(Math.max(0, progress.entitiesDone ?? 0), total);
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return { arm: progress.arm, done, total, percent };
}

export function formatEta(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return "under a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `about ${hours} h ${rest} min`;
}

// ---------------------------------------------------------------------------
// Cohort setup
// ---------------------------------------------------------------------------

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_ROWS = 20000;
export const MIN_MANY = 2;
export const MAX_MANY = 12;

/** Python's repr() of a string, which the backend uses to quote file names in its messages. */
export function pyRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  const body = s.replace(/\\/g, "\\\\").replace(quote === "'" ? /'/g : /"/g, `\\${quote}`);
  return `${quote}${body}${quote}`;
}

/** The backend's own refusal for a file over 50 MB, so it can be shown without uploading the file. */
export function tooLargeMessage(filename: string): string {
  return `${pyRepr(filename)} is larger than the 50 MB limit.`;
}

export function tooManyRowsMessage(filename: string, rows: number): string {
  return `${filename} has ${rows} rows; a harmonize job takes at most ${MAX_ROWS} rows per cohort file.`;
}

export function manyCountMessage(n: number): string {
  return `A many-cohort run takes ${MIN_MANY} to ${MAX_MANY} cohort files (got ${n}).`;
}

export function missingColumnMessage(column: string, filename: string, columns: string[]): string {
  return `Column '${column}' is not in file '${filename}'. Columns found: ${columns.join(", ")}.`;
}

const LABEL_OK = /^[A-Za-z0-9._-]+$/;

export function isValidLabel(label: string): boolean {
  return LABEL_OK.test(label);
}

/** A cohort label from a file name: the stem, with anything outside letters, digits, '.', '-' and '_' made '_'. */
export function labelFromName(name: string): string {
  const stem = name.replace(/\.(tsv|csv|txt)$/i, "");
  const cleaned = stem.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "cohort";
}

/** Labels for a set of names, made distinct by numbering repeats (a, a_2, a_3). */
export function distinctLabels(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const base = labelFromName(n);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });
}

export function guessNameColumn(columns: string[]): string {
  return (
    columns.find((c) => /^name$/i.test(c.trim())) ??
    columns.find((c) => /name|compound|metabolite|analyte|biochemical|protein|gene|test/i.test(c)) ??
    columns[0] ??
    ""
  );
}

export function guessKeyColumn(columns: string[], nameColumn: string): string {
  const others = columns.filter((c) => c !== nameColumn && !inferVocabulary(c));
  return (
    others.find((c) => /^(id|key|row_?id|sample_?id|comp_?id|analyte_?id)$/i.test(c.trim())) ??
    others.find((c) => /(^|[\s_.-])(id|key)$/i.test(c.trim())) ??
    ""
  );
}

const VOCAB_HINTS: Array<[RegExp, string]> = [
  [/hmdb/i, "HMDB"],
  [/chebi/i, "CHEBI"],
  [/pubchem|\bcid\b/i, "PUBCHEM.COMPOUND"],
  [/kegg/i, "KEGG"],
  [/refmet/i, "RM"],
  [/lipid\s*maps?|lmid|lm[_-]?id/i, "LM"],
  [/inchi\s*key/i, "INCHIKEY"],
  [/^cas$|cas[_-]?(number|no|rn)/i, "CAS"],
  [/loinc/i, "LOINC"],
  [/uniprot/i, "UniProtKB"],
  [/ensembl/i, "ENSEMBL"],
  [/ncbi[_-]?gene|entrez/i, "NCBIGene"],
  [/hgnc/i, "HGNC"],
  [/chembl/i, "CHEMBL.COMPOUND"],
  [/drugbank/i, "DRUGBANK"],
  [/mesh/i, "MESH"],
  [/umls/i, "UMLS"],
];

/** The vocabulary a column name suggests, or null when it suggests none. */
export function inferVocabulary(column: string): string | null {
  for (const [re, vocab] of VOCAB_HINTS) if (re.test(column)) return vocab;
  return null;
}

export interface CohortDraftSpec {
  label: string;
  nameColumn: string;
  keyColumn: string;
  /** Identifier columns that are switched on, each with the vocabulary it holds. */
  idColumns: Record<string, string>;
}

/** The API's cohort input: identifier columns grouped by vocabulary, one or more columns each. */
export function toCohortInput(d: CohortDraftSpec): HarmonizeCohortInput {
  const vocabularies: Record<string, string[]> = {};
  for (const [column, vocab] of Object.entries(d.idColumns)) {
    const name = vocab.trim();
    if (!name) continue;
    (vocabularies[name] ??= []).push(column);
  }
  return {
    label: d.label.trim(),
    nameColumn: d.nameColumn,
    ...(d.keyColumn ? { keyColumn: d.keyColumn } : {}),
    vocabularies,
  };
}

/** Every column the spec names that the file's header does not have, as the backend would word it. */
export function missingColumns(d: CohortDraftSpec, filename: string, columns: string[]): string[] {
  const named = [d.nameColumn, ...(d.keyColumn ? [d.keyColumn] : []), ...Object.keys(d.idColumns)].filter(Boolean);
  return named.filter((c) => !columns.includes(c)).map((c) => missingColumnMessage(c, filename, columns));
}

// ---------------------------------------------------------------------------
// Errors and downloads
// ---------------------------------------------------------------------------

/** The message to show for a failed call: the API's detail as written, never a generic failure. */
export function errorMessage(err: unknown): string {
  if (!err) return "Something went wrong.";
  const data = (err as { data?: unknown }).data;
  if (data && typeof data === "object" && "detail" in data) {
    const detail = (data as { detail: unknown }).detail;
    if (typeof detail === "string" && detail) return detail;
    if (Array.isArray(detail)) {
      const parts = detail
        .map((d) => (d && typeof d === "object" && "msg" in d ? String((d as { msg: unknown }).msg) : ""))
        .filter(Boolean);
      if (parts.length) return parts.join("; ");
    }
  }
  if (typeof data === "string" && data.trim()) return data.trim();
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

export function errorStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

/** The file name in a Content-Disposition header, or the fallback. */
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
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : fallback;
}

// ---------------------------------------------------------------------------
// Reading report.json
// ---------------------------------------------------------------------------

export type Report = Record<string, unknown> & { kind?: string };
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Cohort labels in report order. Two-cohort reports keep them as {a, b}; the others as a list. */
export function reportLabels(report: Report): string[] {
  const labels = report.labels;
  if (Array.isArray(labels)) return labels.map(String);
  if (isObj(labels)) return [labels.a, labels.b].filter((x): x is string => typeof x === "string");
  return [];
}

export function getArm(report: Report, arm: "names_only" | "identifier"): Obj | null {
  const arms = report.arms;
  if (!isObj(arms)) return null;
  const a = arms[arm];
  return isObj(a) ? a : null;
}

export interface CohortCounts {
  label: string;
  total: number;
  /** Two cohorts: linked rows. Many cohorts: grouped rows. */
  placed: number;
  unresolved: number;
  errored: number;
  /** Many cohorts only: resolved rows with no node. */
  noNode: number;
}

export interface ArmSummary {
  arm: "names_only" | "identifier";
  /** Two cohorts: links. Many cohorts: groups. */
  main: number;
  facts: Array<{ label: string; value: number; hint?: string }>;
  cohorts: CohortCounts[];
  byBasis: Array<{ basis: string; count: number }>;
}

/** One arm's counts, the same shape for both report families, or null when the arm was skipped. */
export function armSummary(report: Report, arm: "names_only" | "identifier"): ArmSummary | null {
  const data = getArm(report, arm);
  if (!data) return null;
  const summary = isObj(data.summary) ? data.summary : {};
  const labels = reportLabels(report);
  if (report.kind === "harmonize_many") {
    const per = isObj(summary.per_cohort) ? summary.per_cohort : {};
    const idCheck = isObj(summary.id_check) ? summary.id_check : {};
    return {
      arm,
      main: num(summary.groups),
      facts: [
        { label: "Clean groups", value: num(summary.clean_groups) },
        { label: "Groups with multiplicity", value: num(summary.multiplicity_groups), hint: "more than one row from one cohort" },
        { label: "Broad groups", value: num(summary.broad_groups) },
        { label: "Groups across 2+ cohorts", value: num(summary.multi_cohort_groups) },
        { label: "Cross-node entries", value: num(summary.cross_node_entries) },
        { label: "Identifier checks to review", value: num(idCheck.n_review) },
        { label: "Withheld name pairs", value: num(summary.withheld_name_pairs) },
      ],
      cohorts: labels.map((label) => {
        const c = isObj(per[label]) ? (per[label] as Obj) : {};
        return {
          label,
          total: num(c.total),
          placed: num(c.grouped),
          unresolved: num(c.unresolved),
          errored: num(c.errored),
          noNode: num(c.no_node),
        };
      }),
      byBasis: [],
    };
  }
  const basis = isObj(summary.links_by_basis) ? summary.links_by_basis : {};
  return {
    arm,
    main: num(summary.n_links),
    facts: [
      { label: "One-to-one links", value: num(summary.n_one_to_one_links) },
      { label: "Ambiguous links", value: num(summary.n_ambiguous_links), hint: "a row with more than one partner" },
      { label: "Name-only links", value: num(summary.n_name_only_links) },
      { label: "Withheld name matches", value: num(summary.n_name_match_withheld) },
      { label: "Possible misses", value: num(summary.n_possible_missed) },
      { label: "Links needing review", value: num(summary.n_needs_review) },
    ],
    cohorts: labels.map((label) => {
      const c = isObj(summary[label]) ? (summary[label] as Obj) : {};
      return {
        label,
        total: num(c.total),
        placed: num(c.linked),
        unresolved: num(c.unresolved),
        errored: num(c.errors),
        noNode: 0,
      };
    }),
    byBasis: Object.entries(basis).map(([b, n]) => ({ basis: b, count: num(n) })),
  };
}

export interface DiffView {
  counts: Array<{ key: string; label: string; value: number }>;
  sets: Array<{ key: string; label: string; entries: string[] }>;
}

/** How the two arms differ, with each entry written for reading (names next to keys or nodes). */
export function armDiff(report: Report): DiffView | null {
  const diff = report.diff;
  if (!isObj(diff)) return null;
  const counts = isObj(diff.counts) ? diff.counts : {};
  const many = report.kind === "harmonize_many";
  const names = many ? groupNames(report) : linkNames(report);
  const describe = (entry: unknown): string => {
    if (typeof entry === "string") {
      const n = names.get(entry);
      return n ? `${entry} (${n})` : entry;
    }
    if (isObj(entry) && typeof entry.a_key === "string" && typeof entry.b_key === "string") {
      const a = names.get(`a:${entry.a_key}`);
      const b = names.get(`b:${entry.b_key}`);
      return `${a ? `${a} (${entry.a_key})` : entry.a_key} with ${b ? `${b} (${entry.b_key})` : entry.b_key}`;
    }
    return JSON.stringify(entry);
  };
  const keys: Array<[string, string]> = [
    ["names_only_only", many ? "Groups only the names-only arm found" : "Links only the names-only arm found"],
    ["identifier_only", many ? "Groups only the identifier arm found" : "Links only the identifier arm found"],
    ["both", many ? "Groups both arms found" : "Links both arms found"],
  ];
  if (many) keys.push(["membership_changed", "Groups whose membership changed between arms"]);
  return {
    counts: keys.map(([key, label]) => ({ key, label, value: num(counts[key]) })),
    sets: keys.map(([key, label]) => ({
      key,
      label,
      entries: Array.isArray(diff[key]) ? (diff[key] as unknown[]).map(describe) : [],
    })),
  };
}

function linkNames(report: Report): Map<string, string> {
  const out = new Map<string, string>();
  for (const arm of ["names_only", "identifier"] as const) {
    const links = getArm(report, arm)?.links;
    if (!Array.isArray(links)) continue;
    for (const l of links) {
      if (!isObj(l)) continue;
      if (typeof l.a_key === "string" && typeof l.a_name === "string") out.set(`a:${l.a_key}`, l.a_name);
      if (typeof l.b_key === "string" && typeof l.b_name === "string") out.set(`b:${l.b_key}`, l.b_name);
    }
  }
  return out;
}

function groupNames(report: Report): Map<string, string> {
  const out = new Map<string, string>();
  for (const arm of ["names_only", "identifier"] as const) {
    const groups = getArm(report, arm)?.groups;
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!isObj(g) || typeof g.node !== "string" || out.has(g.node)) continue;
      const members = Array.isArray(g.members) ? g.members : [];
      const unique = [...new Set(members.map((m) => (isObj(m) && typeof m.name === "string" ? m.name : "")).filter(Boolean))];
      if (unique.length) out.set(g.node, unique.slice(0, 3).join(", ") + (unique.length > 3 ? ", ..." : ""));
    }
  }
  return out;
}

export interface ExcludedView {
  /** False when this kind of report does not record excluded rows at all. */
  reported: boolean;
  cohorts: Array<{ label: string; rows: Array<{ row: string; reason: string }> }>;
  total: number;
}

export function excludedRows(report: Report): ExcludedView {
  const excluded = report.excluded;
  if (!isObj(excluded)) return { reported: false, cohorts: [], total: 0 };
  const cohorts = Object.entries(excluded).map(([label, rows]) => ({
    label,
    rows: (Array.isArray(rows) ? rows : []).map((r) =>
      isObj(r)
        ? { row: r.row != null ? String(r.row) : "", reason: typeof r.reason === "string" ? r.reason : "" }
        : { row: String(r), reason: "" },
    ),
  }));
  return { reported: true, cohorts, total: cohorts.reduce((s, c) => s + c.rows.length, 0) };
}

export interface NameLinking {
  enabled: boolean | null;
  reason: string;
  decidedBy: string;
}

export function nameLinking(report: Report): NameLinking | null {
  const nl = report.name_linking;
  if (!isObj(nl)) return null;
  return {
    enabled: typeof nl.enabled === "boolean" ? nl.enabled : null,
    reason: typeof nl.reason === "string" ? nl.reason : "",
    decidedBy: typeof nl.decided_by === "string" ? nl.decided_by : "",
  };
}

export function warnings(report: Report): string[] | null {
  return Array.isArray(report.warnings) ? report.warnings.map(String) : null;
}

export interface PinRow {
  label: string;
  value: string;
}

/** The run's version pins as label and value rows. Server paths are never part of a pin. */
export function versionPins(report: Report, status?: { kgBuild?: string; kgVerified?: boolean }): PinRow[] {
  const rows: PinRow[] = [];
  const pins = isObj(report.pins) ? report.pins : null;
  const version = (pins && typeof pins.biomapper_version === "string" && pins.biomapper_version) ||
    (typeof report.biomapper_version === "string" ? report.biomapper_version : "");
  if (version) rows.push({ label: "biomapper", value: version });
  if (pins) {
    const api = isObj(pins.api) ? pins.api : null;
    if (api) {
      const v = typeof api.self_reported_version === "string" ? api.self_reported_version : "";
      const note = typeof api.self_reported_version_label === "string" ? ` (${api.self_reported_version_label})` : "";
      const release = typeof api.engine_release === "string" ? `, engine release ${api.engine_release}` : "";
      rows.push({ label: "API", value: v ? `${v}${note}${release}` : `not reported${release}` });
      if (typeof api.base_url === "string") rows.push({ label: "API address", value: api.base_url });
    }
    const kestrel = isObj(pins.kestrel) ? pins.kestrel : null;
    if (kestrel) {
      if (typeof kestrel.kestrel_version === "string") rows.push({ label: "Kestrel", value: kestrel.kestrel_version });
      const kg = isObj(kestrel.kg_build) ? kestrel.kg_build : null;
      if (kg) {
        const parts = [
          typeof kg.kg_version === "string" ? `version ${kg.kg_version}` : "",
          typeof kg.git_commit === "string" ? `commit ${kg.git_commit.slice(0, 8)}` : "",
          typeof kg.build_timestamp === "string" ? `built ${kg.build_timestamp.slice(0, 10)}` : "",
        ].filter(Boolean);
        if (parts.length) rows.push({ label: "Knowledge graph build", value: parts.join(", ") });
      }
    }
  }
  if (status?.kgBuild && status.kgBuild !== "unknown") {
    rows.push({ label: "KG build (run status)", value: `${status.kgBuild}, ${status.kgVerified ? "verified" : "not verified"}` });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export const ITEM_KIND_LABEL: Record<string, string> = {
  link: "Link",
  group: "Group",
  review: "Review",
  unresolved: "Unresolved",
};

export const BASIS_LABEL: Record<string, string> = {
  node: "same node",
  identifier: "shared identifier",
  name_exact: "same name",
  name_casefold: "same name ignoring case",
};

const ORIGIN_LABEL: Record<string, string> = {
  review_queue: "One-sided identifier check",
  possible_missed: "Possible miss",
  name_match_withheld: "Withheld name match",
  withheld: "Withheld name match",
  cross_node: "Cross-node entry",
  id_check_review: "Identifier did not confirm the node",
};

/** A short, readable account of what an item is, from its kind and detail. */
export function describeItem(kind: string, detail: Record<string, unknown>): string[] {
  const d = detail ?? {};
  const out: string[] = [];
  if (kind === "link") {
    out.push(d.ambiguous ? "Ambiguous" : "One-to-one");
    if (typeof d.basis === "string") out.push(`Basis: ${d.basis} (${BASIS_LABEL[d.basis] ?? d.basis})`);
    if (d.aPartners != null || d.bPartners != null) out.push(`Partners: ${num(d.aPartners)} and ${num(d.bPartners)}`);
  } else if (kind === "group") {
    if (typeof d.node === "string") out.push(`Node ${d.node}`);
    const flags = [d.clean ? "clean" : "", d.multiplicity ? "multiplicity" : "", d.broad ? "broad" : ""].filter(Boolean);
    out.push(flags.length ? flags.join(", ") : "not clean");
    if (Array.isArray(d.cohorts)) out.push(`${d.cohorts.length} cohort${d.cohorts.length === 1 ? "" : "s"}`);
  } else if (kind === "review") {
    const origin = typeof d.origin === "string" ? d.origin : "";
    out.push(ORIGIN_LABEL[origin] ?? (typeof d.reason === "string" ? d.reason : "Review entry"));
    if (origin === "review_queue") {
      out.push(`${String(d.vocabulary ?? "")} ${String(d.code ?? "")}: ${String(d.status ?? "")}`.trim());
    } else if (origin === "cross_node") {
      out.push(`${String(d.nodeA ?? "")} and ${String(d.nodeB ?? "")}`);
    } else if (origin === "id_check_review" && isObj(d.check)) {
      const declared = Array.isArray(d.check.declared) ? d.check.declared.join(", ") : "";
      out.push(`${String(d.check.status ?? "")}${declared ? `: ${declared}` : ""}`);
    }
  } else if (kind === "unresolved") {
    const bucket = typeof d.bucket === "string" ? d.bucket : typeof d.status === "string" ? d.status : "unresolved";
    out.push(bucket === "no_node" ? "Resolved, no node" : bucket === "errored" ? "Errored" : "Unresolved");
    if (typeof d.error === "string" && d.error) out.push(d.error);
  }
  return out.filter(Boolean);
}
