// Pure helpers for the harmonization screen: run states and stages, progress, error text, cohort setup
// guesses and spec building, and typed readers over report.json (schema_version 1). No React here, so every
// rule the screen depends on can be unit tested.

import type {
  HarmonizeCohortInput,
  HarmonizeRunStatus,
  HarmonizeRunStatusState,
} from "@workspace/api-client-react";

// ---------------------------------------------------------------------------
// Run kinds, states and the staged flow
// ---------------------------------------------------------------------------

export type RunKind = "harmonize_cohorts" | "harmonize_many" | "harmonize_results";

export const KIND_LABEL: Record<RunKind, string> = {
  harmonize_cohorts: "Two cohorts",
  harmonize_many: "Many cohorts",
  harmonize_results: "Two finished mapping jobs",
};

export function kindLabel(kind: string | undefined | null): string {
  return (kind && KIND_LABEL[kind as RunKind]) || "Harmonization run";
}

export type StateTone = "neutral" | "info" | "success" | "warning" | "danger";

interface StateInfo {
  label: string;
  tone: StateTone;
  /** What the state means for the user, in one sentence. */
  meaning: string;
}

/** Every state the package (and this app, for "unknown") can report, in words. */
export const STATE_INFO: Record<HarmonizeRunStatusState, StateInfo> = {
  queued: { label: "Queued", tone: "info", meaning: "Waiting for its turn. Runs go one at a time." },
  running: { label: "Running", tone: "info", meaning: "Mapping and harmonizing the cohorts now." },
  complete: { label: "Complete", tone: "success", meaning: "Finished. The results are ready to review." },
  partial: {
    label: "Partial",
    tone: "warning",
    meaning: "Finished with some rows that could not be mapped. The results are ready to review.",
  },
  stalled: { label: "Stalled", tone: "warning", meaning: "The run stopped making progress. Resume it to continue." },
  paused: { label: "Paused", tone: "warning", meaning: "The run is paused. Resume it to continue." },
  expired: { label: "Expired", tone: "warning", meaning: "The run timed out before it finished. Resume it to continue." },
  cancelled: { label: "Cancelled", tone: "neutral", meaning: "The run was cancelled. What was mapped is kept; resume continues it." },
  failed: { label: "Failed", tone: "danger", meaning: "The run failed." },
  owned_elsewhere: {
    label: "Owned elsewhere",
    tone: "warning",
    meaning: "Another server process holds this run.",
  },
  unknown: { label: "Unknown", tone: "neutral", meaning: "The job runner no longer knows this run." },
};

export function stateInfo(state: string | undefined | null): StateInfo {
  if (state && state in STATE_INFO) return STATE_INFO[state as HarmonizeRunStatusState];
  // Never blank or "undefined": an unexpected word is shown as the package wrote it.
  return { label: state ? humanize(state) : "Unknown", tone: "neutral", meaning: "" };
}

/** States whose report, items and exports exist (results routes answer 409 before). */
export function hasResults(state: string | undefined | null): boolean {
  return state === "complete" || state === "partial";
}

/** States in which the run is still working or waiting to work. */
export function isActive(state: string | undefined | null): boolean {
  return state === "queued" || state === "running";
}

/** A run that has not finished can be cancelled. */
export function canCancel(run: Pick<HarmonizeRunStatus, "state" | "kind">): boolean {
  if (run.kind === "harmonize_results") return false;
  return ["queued", "running", "paused", "stalled", "expired", "owned_elsewhere"].includes(run.state);
}

/** Cancelled, paused, stalled or expired runs can be resumed. */
export function canResume(run: Pick<HarmonizeRunStatus, "state" | "kind">): boolean {
  if (run.kind === "harmonize_results") return false;
  return ["cancelled", "paused", "stalled", "expired"].includes(run.state);
}

/** States that will not change on their own, so the screen stops polling. */
export function isSettled(state: string | undefined | null): boolean {
  return !isActive(state);
}

export const STAGES = ["setup", "run", "review", "export"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_TITLE: Record<Stage, string> = {
  setup: "Set up cohorts",
  run: "Run",
  review: "Review and flag",
  export: "Export",
};

export function isStage(value: string | undefined | null): value is Stage {
  return !!value && (STAGES as readonly string[]).includes(value);
}

/** The stage a run opens on when the URL names none: its results once they exist, else its progress. */
export function defaultStage(state: string | undefined | null): Stage {
  return hasResults(state) ? "review" : "run";
}

/** Review and export need the run's results. */
export function stageReachable(stage: Stage, state: string | undefined | null): boolean {
  if (stage === "review" || stage === "export") return hasResults(state);
  return true;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export const ARM_LABEL: Record<string, string> = {
  names_only: "Names-only arm",
  identifier: "Identifier arm",
  review: "Review checks",
};

export function armLabel(arm: string | undefined | null): string {
  if (!arm) return "Arm";
  return ARM_LABEL[arm] ?? humanize(arm);
}

/** The arms a run of this kind goes through, in order. */
export function armsFor(kind: string | undefined | null): string[] {
  if (kind === "harmonize_cohorts") return ["names_only", "identifier", "review"];
  if (kind === "harmonize_many") return ["names_only", "identifier"];
  return ["names_only"];
}

export interface ArmProgress {
  arm: string;
  done: number;
  total: number;
  /** 0 to 100, never more. */
  percent: number;
}

/**
 * The current arm's progress: its entities done out of its total, clamped to 100 percent. The job-wide
 * entitiesMapped and entitiesTotal are never used: the package counts them per arm and across restarts.
 */
export function armProgress(progress: HarmonizeRunStatus["progress"]): ArmProgress | null {
  if (!progress) return null;
  const total = Math.max(0, Number(progress.entitiesTotal) || 0);
  const done = Math.max(0, Math.min(Number(progress.entitiesDone) || 0, total));
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return { arm: progress.arm, done, total, percent };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The message to show for a failed call, as the server wrote it: the response's `detail` when it is text,
 * FastAPI's validation list joined when it is a list, else the error's own message.
 */
export function errorMessage(err: unknown, fallback = "Something went wrong. Try again."): string {
  if (!err) return fallback;
  const data = (err as { data?: unknown }).data;
  if (data && typeof data === "object") {
    const detail = (data as { detail?: unknown }).detail;
    if (typeof detail === "string" && detail.trim()) return detail;
    if (Array.isArray(detail)) {
      const parts = detail
        .map((d) => {
          if (!d || typeof d !== "object") return String(d);
          const loc = Array.isArray((d as { loc?: unknown }).loc)
            ? ((d as { loc: unknown[] }).loc.filter((p) => p !== "body").join("."))
            : "";
          const msg = String((d as { msg?: unknown }).msg ?? "");
          return loc ? `${loc}: ${msg}` : msg;
        })
        .filter(Boolean);
      if (parts.length) return parts.join("; ");
    }
  }
  if (typeof data === "string" && data.trim()) return data.trim();
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export function errorStatus(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

// ---------------------------------------------------------------------------
// Cohort setup
// ---------------------------------------------------------------------------

export interface HeaderColumn {
  /** 0-based position in the header. */
  index: number;
  name: string;
  /** What the screen shows for this column. */
  display: string;
  /** Whether the column can be chosen: the server can address it by this name. */
  usable: boolean;
  reason: string | null;
}

/**
 * The header's columns as the screen offers them. The package reads rows with csv.DictReader, so a repeated name
 * reads only the last column with that name, and the screen uses a blank value to mean "no column". So a blank
 * name cannot be chosen, and of a repeated name only the last column can be (sent under its own name).
 */
export function headerColumns(header: string[]): HeaderColumn[] {
  const lastIndex = new Map<string, number>();
  header.forEach((name, i) => lastIndex.set(name, i));
  return header.map((name, index) => {
    if (name.trim() === "") {
      return { index, name, display: `(unnamed column ${index + 1})`, usable: false, reason: "has no name" };
    }
    if (lastIndex.get(name) !== index) {
      return { index, name, display: `${name} (column ${index + 1})`, usable: false, reason: "repeated name, not read" };
    }
    return { index, name, display: name, usable: true, reason: null };
  });
}

/** Sentences about the header's blank and repeated names, for the inspect summary. Empty when there are none. */
export function headerProblems(header: string[]): string[] {
  const out: string[] = [];
  header.forEach((name, i) => {
    if (name.trim() === "") out.push(`Column ${i + 1} has no name, so it cannot be chosen.`);
  });
  const counts = new Map<string, number[]>();
  header.forEach((name, i) => {
    if (name.trim() !== "") counts.set(name, [...(counts.get(name) ?? []), i]);
  });
  for (const [name, idx] of counts) {
    if (idx.length > 1) {
      out.push(`'${name}' names ${idx.length} columns. biomapper reads only the last of them (column ${idx[idx.length - 1] + 1}).`);
    }
  }
  return out;
}

/** A label the package accepts: letters, digits, '.', '-' and '_'. */
export function labelFromFilename(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "");
  const cleaned = stem.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "cohort";
}

/** `wanted`, or `wanted_2`, `wanted_3`... so it differs from every label in `taken`. */
export function distinctLabel(wanted: string, taken: string[]): string {
  if (!taken.includes(wanted)) return wanted;
  let n = 2;
  while (taken.includes(`${wanted}_${n}`)) n += 1;
  return `${wanted}_${n}`;
}

const NAME_COLUMN_HINTS = [/^name$/i, /^(analyte|metabolite|compound|biochemical|chemical|protein|gene|lab|test)[ _-]?name$/i, /name/i, /^(analyte|metabolite|compound|biochemical)$/i];
const KEY_COLUMN_HINTS = [/^id$/i, /^key$/i, /^(row|analyte|feature|comp|compound|metabolite|sample)[ _-]?(id|key)$/i, /[ _-]key$/i];

/** The column most likely to hold the entity names; the first column when nothing looks like one. */
export function guessNameColumn(columns: string[]): string | undefined {
  for (const hint of NAME_COLUMN_HINTS) {
    const hit = columns.find((c) => hint.test(c.trim()));
    if (hit) return hit;
  }
  return columns[0];
}

/** A column that looks like a row key, or none. */
export function guessKeyColumn(columns: string[], nameColumn?: string): string | undefined {
  for (const hint of KEY_COLUMN_HINTS) {
    const hit = columns.find((c) => c !== nameColumn && hint.test(c.trim()));
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The vocabulary a column probably holds, from its name: "hmdb", "HMDB_ID" and "hmdb id" give HMDB when HMDB is
 * among `vocabularies`. Nothing when there is no match; the user can still type one.
 */
export function guessVocabulary(column: string, vocabularies: string[]): string | undefined {
  const base = column.trim().replace(/[ _-]*(ids?|codes?|curies?|accessions?)$/i, "").trim();
  if (!base) return undefined;
  const upper = base.toUpperCase().replace(/[ _-]+/g, ".");
  const exact = vocabularies.find((v) => v.toUpperCase() === upper);
  if (exact) return exact;
  const loose = vocabularies.find((v) => v.toUpperCase().replace(/[^A-Z0-9]/g, "") === upper.replace(/[^A-Z0-9]/g, ""));
  return loose;
}

/** Per-column vocabulary choices as the spec wants them: vocabulary name to its columns, blanks left out. */
export function vocabulariesFromColumns(byColumn: Record<string, string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [column, vocab] of Object.entries(byColumn)) {
    const name = vocab.trim();
    if (!name) continue;
    (out[name] ??= []).push(column);
  }
  return out;
}

export interface CohortDraft {
  label: string;
  nameColumn: string;
  keyColumn: string;
  /** column name to vocabulary name ("" or absent when the column holds no identifier) */
  vocabByColumn: Record<string, string>;
}

/**
 * Fill a cohort's column choices from a freshly read header. Choices the user already made are kept, even when
 * the new file lacks that column (the server then refuses the run and says which column is missing); only blank
 * choices are guessed. The key column is guessed only on the first file.
 */
export function prefillDraft(
  draft: CohortDraft,
  columns: string[],
  vocabSuggestions: string[],
  firstFile: boolean,
): CohortDraft {
  const nameColumn = draft.nameColumn || guessNameColumn(columns) || "";
  const keyColumn = draft.keyColumn || (firstFile ? guessKeyColumn(columns, nameColumn) ?? "" : "");
  const vocabByColumn = { ...draft.vocabByColumn };
  if (firstFile) {
    for (const c of columns) {
      if (c === nameColumn || c === keyColumn || vocabByColumn[c] !== undefined) continue;
      const guess = guessVocabulary(c, vocabSuggestions);
      if (guess) vocabByColumn[c] = guess;
    }
  }
  return { ...draft, nameColumn, keyColumn, vocabByColumn };
}

/** One cohort's part of the spec. Blank key column is sent as null. */
export function cohortInput(d: CohortDraft): HarmonizeCohortInput {
  return {
    label: d.label.trim(),
    nameColumn: d.nameColumn,
    keyColumn: d.keyColumn ? d.keyColumn : null,
    vocabularies: vocabulariesFromColumns(d.vocabByColumn),
  };
}

/** The spec's optional category: blank means none, otherwise sent as written. */
export function categoryOrNull(category: string): string | null {
  return category.trim() ? category : null;
}

/** The many-cohort count rule, worded as the package words it. */
export const MAX_COHORTS = 12;
export function manyCountMessage(n: number): string | null {
  if (n >= 2 && n <= MAX_COHORTS) return null;
  return `A many-cohort run takes 2 to ${MAX_COHORTS} cohort files (got ${n}).`;
}

// ---------------------------------------------------------------------------
// Report readers (report.json, schema_version 1, snake_case)
// ---------------------------------------------------------------------------

export type Json = Record<string, unknown>;

export function asObject(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

export function asArray<T = Json>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Cohort labels in report order: `{a, b}` for two cohorts, a list for many (and finished-job runs). */
export function reportLabels(report: Json | null | undefined): string[] {
  const labels = report?.labels;
  if (Array.isArray(labels)) return labels.map(String);
  const obj = asObject(labels);
  if (obj) return [String(obj.a ?? "a"), String(obj.b ?? "b")];
  return [];
}

export function isMany(kind: string | undefined | null): boolean {
  return kind === "harmonize_many";
}

export const ARMS = ["names_only", "identifier"] as const;
export type Arm = (typeof ARMS)[number];

/** The arm's data, or null when the arm was skipped (null on two-cohort runs, absent on many-cohort runs). */
export function armData(report: Json | null | undefined, arm: Arm): Json | null {
  return asObject(asObject(report?.arms)?.[arm]);
}

/** Why the identifier arm did not run, when it did not. */
export function identifierSkippedReason(report: Json | null | undefined): string | null {
  const reason = str(report?.identifier_skipped_reason);
  if (reason) return reason;
  return null;
}

export interface CohortCounts {
  label: string;
  total: number | null;
  linked: number | null;
  unresolved: number | null;
  errors: number | null;
  grouped: number | null;
  noNode: number | null;
}

/** Per-cohort counts of one arm. Two-cohort summaries are keyed by label; many-cohort ones sit in per_cohort. */
export function cohortCounts(report: Json, arm: Arm): CohortCounts[] {
  const data = armData(report, arm);
  const summary = asObject(data?.summary);
  if (!summary) return [];
  const perCohort = asObject(summary.per_cohort);
  return reportLabels(report).map((label) => {
    const row = asObject(perCohort ? perCohort[label] : summary[label]) ?? {};
    return {
      label,
      total: num(row.total),
      linked: num(row.linked),
      unresolved: num(row.unresolved),
      errors: num(row.errors ?? row.errored),
      grouped: num(row.grouped),
      noNode: num(row.no_node),
    };
  });
}

/** Rows of one arm that did not resolve (or errored), per cohort, with key and name. */
export interface UnresolvedRow {
  cohort: string;
  key: string;
  name: string | null;
  bucket: string;
  error: string | null;
}

export function unresolvedRows(report: Json, arm: Arm): UnresolvedRow[] {
  const data = armData(report, arm);
  if (!data) return [];
  const out: UnresolvedRow[] = [];
  const notGrouped = asObject(data.not_grouped);
  if (notGrouped) {
    for (const [cohort, rows] of Object.entries(notGrouped)) {
      for (const r of asArray(rows)) {
        out.push({
          cohort,
          key: String(r.key ?? ""),
          name: str(r.name),
          bucket: String(r.bucket ?? "unresolved"),
          error: str(r.error),
        });
      }
    }
    return out;
  }
  const pushRows = (field: string, keysField: string, bucket: string) => {
    const rows = asObject(data[field]);
    if (rows) {
      for (const [cohort, list] of Object.entries(rows)) {
        for (const r of asArray(list)) {
          out.push({ cohort, key: String(r.key ?? ""), name: str(r.name), bucket, error: str(r.error) });
        }
      }
      return;
    }
    const keys = asObject(data[keysField]);
    if (keys) {
      for (const [cohort, list] of Object.entries(keys)) {
        for (const k of asArray<unknown>(list)) out.push({ cohort, key: String(k), name: null, bucket, error: null });
      }
    }
  };
  pushRows("unresolved_rows", "unresolved", "unresolved");
  pushRows("errored_rows", "errors", "errored");
  return out;
}

/** Rows excluded from each cohort (blank names), with the reason. */
export function excludedRows(report: Json): { cohort: string; rows: Json[] }[] {
  const excluded = asObject(report.excluded);
  if (!excluded) return [];
  return Object.entries(excluded).map(([cohort, rows]) => ({ cohort, rows: asArray(rows) }));
}

export function warnings(report: Json): string[] {
  return asArray<unknown>(report.warnings).map(String).filter(Boolean);
}

export interface NameLinking {
  enabled: boolean;
  reason: string;
  decidedBy: string | null;
}

export function nameLinking(report: Json | null | undefined): NameLinking | null {
  const nl = asObject(report?.name_linking);
  if (!nl) return null;
  return { enabled: nl.enabled === true, reason: String(nl.reason ?? ""), decidedBy: str(nl.decided_by) };
}

export interface PinRow {
  label: string;
  value: string;
}

/** The run's version pins, flattened into readable rows. */
export function pinRows(report: Json, status?: Pick<HarmonizeRunStatus, "kgBuild" | "kgVerified"> | null): PinRow[] {
  const rows: PinRow[] = [];
  const pins = asObject(report.pins);
  const version = str(report.biomapper_version) ?? str(pins?.biomapper_version);
  rows.push({ label: "biomapper", value: version ?? "Not recorded" });
  const api = asObject(pins?.api);
  if (api) {
    const parts = [str(api.base_url), str(api.status)].filter(Boolean);
    const self = str(api.self_reported_version);
    if (self) parts.push(`version ${self}${api.self_reported_version_label ? ` (${api.self_reported_version_label})` : ""}`);
    const engine = str(api.engine_release);
    if (engine) parts.push(`engine release ${engine}`);
    rows.push({ label: "API", value: parts.join(", ") || "Not recorded" });
  } else {
    rows.push({ label: "API", value: "Not recorded" });
  }
  const kestrel = asObject(pins?.kestrel);
  if (kestrel) {
    const parts = [str(kestrel.url), kestrel.kestrel_version ? `version ${kestrel.kestrel_version}` : null].filter(Boolean);
    rows.push({ label: "Kestrel", value: parts.join(", ") || "Not recorded" });
    const kg = asObject(kestrel.kg_build);
    if (kg) {
      const commit = str(kg.git_commit);
      const parts2 = [
        kg.kg_version ? `KG ${kg.kg_version}` : null,
        commit ? `commit ${commit.slice(0, 8)}` : null,
        str(kg.build_timestamp) ? `built ${String(kg.build_timestamp).slice(0, 10)}` : null,
        kg.biolink_version ? `Biolink ${kg.biolink_version}` : null,
      ].filter(Boolean);
      rows.push({ label: "Knowledge graph build", value: parts2.join(", ") || "Not recorded" });
    }
    if (str(kestrel.label)) rows.push({ label: "Kestrel note", value: String(kestrel.label) });
  } else {
    rows.push({ label: "Kestrel", value: "Not recorded" });
  }
  if (status) {
    const build = status.kgBuild && status.kgBuild !== "unknown" ? status.kgBuild : "unknown";
    rows.push({
      label: "Run status KG build",
      value: `${build} (${status.kgVerified ? "verified" : "not verified"})`,
    });
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

export const ORIGIN_LABEL: Record<string, string> = {
  links: "Link",
  groups: "Group",
  review_queue: "One-sided identifier check",
  possible_missed: "Possible miss",
  name_match_withheld: "Withheld name match",
  withheld: "Withheld name match",
  cross_node: "Cross-node entry",
  id_check_review: "Identifier did not confirm node",
  unresolved_rows: "Unresolved row",
  unresolved: "Unresolved row",
  errored_rows: "Errored row",
  errors: "Errored row",
  not_grouped: "Not grouped",
};

export function originLabel(origin: unknown): string {
  return (typeof origin === "string" && ORIGIN_LABEL[origin]) || (typeof origin === "string" ? humanize(origin) : "");
}

/** A short description of what an item is, from its detail. */
export function itemSummary(kind: string, detail: Record<string, unknown>): string[] {
  const parts: string[] = [];
  const origin = detail.origin;
  if (kind === "link") {
    if (detail.ambiguous === true) parts.push("Ambiguous");
    else if (detail.oneToOne === true) parts.push("One-to-one");
    if (typeof detail.basis === "string") parts.push(`basis ${detail.basis}`);
    const ap = num(detail.aPartners);
    const bp = num(detail.bPartners);
    if (ap !== null || bp !== null) parts.push(`partners ${ap ?? "?"} : ${bp ?? "?"}`);
  } else if (kind === "group") {
    if (detail.clean === true) parts.push("Clean");
    if (detail.multiplicity === true) parts.push("Multiplicity");
    if (detail.broad === true) parts.push("Broad");
    if (typeof detail.node === "string") parts.push(`node ${detail.node}`);
  } else if (kind === "review") {
    parts.push(originLabel(origin));
    if (typeof detail.status === "string") parts.push(detail.status);
    const check = asObject(detail.check);
    if (check && typeof check.status === "string") parts.push(String(check.status));
    if (typeof detail.vocabulary === "string" && typeof detail.code === "string") parts.push(`${detail.vocabulary} ${detail.code}`);
    if (typeof detail.nodeA === "string" && typeof detail.nodeB === "string") parts.push(`${detail.nodeA} vs ${detail.nodeB}`);
  } else if (kind === "unresolved") {
    parts.push(typeof detail.bucket === "string" ? humanize(detail.bucket) : "Unresolved");
    if (typeof detail.error === "string" && detail.error) parts.push(detail.error);
  }
  return parts.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const EXPORT_TABLES = ["links", "groups", "review", "unresolved"] as const;
export type ExportTable = (typeof EXPORT_TABLES)[number] | "eitl_pairs";
export const EXPORT_FORMATS = ["csv", "tsv", "json"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** The filename in a Content-Disposition header, or null. */
export function filenameFromDisposition(header: string | null | undefined): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i.exec(header);
  const name = plain ? (plain[1] ?? plain[2])?.trim() : null;
  return name || null;
}

/** The skipped-one-sided count from the export header, or null when absent or not a number. */
export function skippedFromHeader(header: string | null | undefined): number | null {
  if (header == null || header.trim() === "") return null;
  const n = Number(header);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Which tables hold rows on a run of this kind. */
export function tableApplies(table: ExportTable, kind: string | undefined | null): boolean {
  if (table === "groups") return kind === "harmonize_many";
  if (table === "links") return kind !== "harmonize_many";
  return true;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** snake_case or kebab-case to "Sentence case". */
export function humanize(value: string): string {
  const s = value.replace(/[_-]+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** "Nov 14, 2026, 06:42" in the reader's locale, or the input when it is not a date. */
export function formatWhen(iso: string | undefined | null): string {
  if (!iso) return "Not recorded";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
