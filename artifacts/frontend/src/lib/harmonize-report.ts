// Reading report.json (schema_version 1) for the workbench. The report is passed through as the package wrote
// it (snake_case), and its shape differs by kind: harmonize_cohorts and harmonize_results are two-sided (links),
// harmonize_many is node groups. These readers never throw on a missing field; they return what is there.

export type Report = Record<string, unknown>;
type Obj = Record<string, unknown>;

export const ARMS = ["names_only", "identifier"] as const;
export type Arm = (typeof ARMS)[number];

function obj(v: unknown): Obj | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function n(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function reportKind(report: Report): string {
  return typeof report.kind === "string" ? report.kind : "";
}

export function isMany(report: Report): boolean {
  return reportKind(report) === "harmonize_many";
}

/** Cohort labels in report order (a dict {a, b} on two-cohort reports, a list otherwise). */
export function reportLabels(report: Report): string[] {
  const labels = report.labels;
  if (Array.isArray(labels)) return labels.map(String);
  const o = obj(labels);
  if (o) return [o.a, o.b].filter((x): x is string => typeof x === "string");
  return [];
}

export function armData(report: Report, arm: Arm): Obj | null {
  return obj(obj(report.arms)?.[arm]);
}

/** Why the identifier arm did not run, or null when it ran. */
export function identifierSkipped(report: Report): { skipped: boolean; reason: string | null } {
  const reason = typeof report.identifier_skipped_reason === "string" ? report.identifier_skipped_reason : null;
  const data = armData(report, "identifier");
  if (reportKind(report) === "harmonize_results") {
    return { skipped: true, reason: reason ?? "A run over two finished mapping jobs has only the names-only arm: the jobs were mapped once, without a separate identifier pass." };
  }
  if (!data) return { skipped: true, reason };
  return { skipped: false, reason: null };
}

export interface Count {
  label: string;
  value: number;
  /** Item filter that shows these items in the table, when there is one. */
  hint?: string;
}

export interface ArmSummary {
  arm: Arm;
  skipped: boolean;
  reason: string | null;
  headline: Count[];
  perCohort: { cohort: string; counts: Count[] }[];
}

function twoCohortSummary(data: Obj, labels: string[], arm: Arm): ArmSummary {
  const s = obj(data.summary) ?? {};
  const links = arr(data.links);
  const headline: Count[] = [
    { label: "Links", value: n(s.n_links) ?? links.length },
    { label: "One-to-one", value: n(s.n_one_to_one_links) ?? links.filter((l) => obj(l)?.one_to_one === true).length },
    { label: "Ambiguous", value: n(s.n_ambiguous_links) ?? links.filter((l) => obj(l)?.ambiguous === true).length },
    { label: "Withheld name matches", value: n(s.n_name_match_withheld) ?? arr(data.name_match_withheld).length },
    { label: "Possible misses", value: n(s.n_possible_missed) ?? arr(data.possible_missed).length },
  ];
  const perCohort = labels.map((cohort) => {
    const c = obj(s[cohort]) ?? {};
    const unresolvedRows = arr(obj(data.unresolved_rows)?.[cohort] ?? obj(data.unresolved)?.[cohort]).length;
    const erroredRows = arr(obj(data.errored_rows)?.[cohort] ?? obj(data.errors)?.[cohort]).length;
    return {
      cohort,
      counts: [
        { label: "Rows", value: n(c.total) ?? 0 },
        { label: "Linked", value: n(c.linked) ?? 0 },
        { label: "Unresolved", value: n(c.unresolved) ?? unresolvedRows },
        { label: "Errored", value: n(c.errors) ?? erroredRows },
      ],
    };
  });
  return { arm, skipped: false, reason: null, headline, perCohort };
}

function manySummary(data: Obj, labels: string[], arm: Arm): ArmSummary {
  const s = obj(data.summary) ?? {};
  const groups = arr(data.groups);
  const notGrouped = obj(data.not_grouped) ?? {};
  const headline: Count[] = [
    { label: "Groups", value: n(s.groups) ?? groups.length },
    { label: "Across cohorts", value: n(s.multi_cohort_groups) ?? 0 },
    { label: "With multiplicity", value: n(s.multiplicity_groups) ?? groups.filter((g) => obj(g)?.multiplicity === true).length },
    { label: "Broad", value: n(s.broad_groups) ?? groups.filter((g) => obj(g)?.broad === true).length },
    { label: "Cross-node entries", value: n(s.cross_node_entries) ?? arr(data.cross_node).length },
    { label: "Identifier checks to review", value: arr(data.id_check_review).length },
    { label: "Withheld name matches", value: arr(data.withheld).length },
  ];
  const perCohortSummary = obj(s.per_cohort) ?? {};
  const perCohort = labels.map((cohort) => {
    const pc = obj(perCohortSummary[cohort]) ?? {};
    const rows = arr(notGrouped[cohort]).map((r) => obj(r) ?? {});
    const bucket = (b: string) => rows.filter((r) => r.bucket === b).length;
    return {
      cohort,
      counts: [
        { label: "Rows", value: n(pc.total) ?? 0 },
        { label: "Grouped", value: n(pc.grouped) ?? 0 },
        { label: "No node", value: n(pc.no_node) ?? bucket("no_node") },
        { label: "Unresolved", value: n(pc.unresolved) ?? bucket("unresolved") },
        { label: "Errored", value: n(pc.errored) ?? bucket("errored") },
      ],
    };
  });
  return { arm, skipped: false, reason: null, headline, perCohort };
}

export function armSummary(report: Report, arm: Arm): ArmSummary {
  const labels = reportLabels(report);
  const data = armData(report, arm);
  if (!data) {
    const skip = arm === "identifier" ? identifierSkipped(report) : { skipped: true, reason: null };
    return { arm, skipped: true, reason: skip.reason, headline: [], perCohort: [] };
  }
  return isMany(report) ? manySummary(data, labels, arm) : twoCohortSummary(data, labels, arm);
}

// ---------------------------------------------------------------------------
// Diff between the arms
// ---------------------------------------------------------------------------

export interface DiffView {
  counts: Count[];
  sets: { key: string; label: string; entries: string[] }[];
}

function linkNames(report: Report): Map<string, string> {
  // "a_key|b_key" -> "Glucose and D-Glucose", from either arm's links.
  const names = new Map<string, string>();
  for (const arm of ARMS) {
    for (const l of arr(armData(report, arm)?.links)) {
      const link = obj(l);
      if (!link) continue;
      const k = `${link.a_key}|${link.b_key}`;
      if (!names.has(k) && (link.a_name || link.b_name)) names.set(k, `${link.a_name ?? link.a_key} and ${link.b_name ?? link.b_key}`);
    }
  }
  return names;
}

function groupNames(report: Report): Map<string, string> {
  const names = new Map<string, string>();
  for (const arm of ARMS) {
    for (const g of arr(armData(report, arm)?.groups)) {
      const group = obj(g);
      if (!group || typeof group.node !== "string" || names.has(group.node)) continue;
      const memberNames = [...new Set(arr(group.members).map((m) => obj(m)?.name).filter((x): x is string => typeof x === "string"))];
      names.set(group.node, memberNames.slice(0, 3).join(", "));
    }
  }
  return names;
}

const DIFF_SETS: { key: string; label: string }[] = [
  { key: "names_only_only", label: "Only the names-only arm found" },
  { key: "identifier_only", label: "Only the identifier arm found" },
  { key: "both", label: "Both arms found" },
  { key: "membership_changed", label: "Groups whose membership changed" },
];

export function diffView(report: Report): DiffView | null {
  const diff = obj(report.diff);
  if (!diff) return null;
  const counts = obj(diff.counts) ?? {};
  const many = isMany(report);
  const lnames = many ? new Map<string, string>() : linkNames(report);
  const gnames = many ? groupNames(report) : new Map<string, string>();
  const describe = (entry: unknown): string => {
    if (typeof entry === "string") {
      const name = gnames.get(entry);
      return name ? `${entry} (${name})` : entry;
    }
    const e = obj(entry);
    if (e && "a_key" in e) {
      const k = `${e.a_key}|${e.b_key}`;
      const name = lnames.get(k);
      return `${e.a_key} with ${e.b_key}${name ? ` (${name})` : ""}`;
    }
    return JSON.stringify(entry);
  };
  const sets = DIFF_SETS.filter((s) => s.key !== "membership_changed" || many).map((s) => ({
    key: s.key,
    label: s.label,
    entries: arr(diff[s.key]).map(describe),
  }));
  return {
    counts: sets.map((s) => ({ label: s.label, value: n(counts[s.key]) ?? s.entries.length })),
    sets,
  };
}

// ---------------------------------------------------------------------------
// Run-level facts
// ---------------------------------------------------------------------------

export interface NameLinking {
  enabled: boolean | null;
  decidedBy: string | null;
  reason: string | null;
}

export function nameLinking(report: Report): NameLinking | null {
  const nl = obj(report.name_linking);
  if (!nl) return null;
  return {
    enabled: typeof nl.enabled === "boolean" ? nl.enabled : null,
    decidedBy: typeof nl.decided_by === "string" ? nl.decided_by : null,
    reason: typeof nl.reason === "string" ? nl.reason : null,
  };
}

export function warnings(report: Report): string[] {
  return arr(report.warnings).map(String);
}

/** Excluded rows per cohort (blank names), with reasons. */
export function excluded(report: Report): { cohort: string; rows: { key: string; reason: string }[] }[] {
  const ex = obj(report.excluded);
  const labels = reportLabels(report);
  const cohorts = labels.length ? labels : Object.keys(ex ?? {});
  return cohorts.map((cohort) => ({
    cohort,
    rows: arr(ex?.[cohort]).map((r) => {
      const row = obj(r);
      if (!row) return { key: String(r), reason: "" };
      const key = row.key ?? row.row ?? row.index ?? "";
      return { key: String(key), reason: typeof row.reason === "string" ? row.reason : "" };
    }),
  }));
}

/** The one-sided identifier checks (two-cohort `review`, every entry with its status). */
export function identifierChecks(report: Report): Obj[] {
  return arr(report.review).map((r) => obj(r)).filter((r): r is Obj => r !== null);
}

export interface Pin {
  label: string;
  value: string;
}

/** Version pins: biomapper, the mapping API, Kestrel and the knowledge graph build. */
export function pins(report: Report, status?: { kgBuild?: string; kgVerified?: boolean }): Pin[] {
  const p = obj(report.pins) ?? obj(obj(report.summary)?.pins) ?? {};
  const out: Pin[] = [];
  const version = (typeof report.biomapper_version === "string" && report.biomapper_version) || (typeof p.biomapper_version === "string" && p.biomapper_version);
  if (version) out.push({ label: "biomapper", value: version });
  const api = obj(p.api);
  if (api) {
    const bits = [api.base_url, api.self_reported_version ? `version ${api.self_reported_version}${api.self_reported_version_label ? ` (${api.self_reported_version_label})` : ""}` : null, api.engine_release && api.engine_release !== "unavailable" ? `engine ${api.engine_release}` : null, api.status ? `status ${api.status}` : null]
      .filter(Boolean)
      .join(", ");
    if (bits) out.push({ label: "Mapping API", value: bits });
  }
  const kestrel = obj(p.kestrel);
  if (kestrel) {
    const v = kestrel.kestrel_version ? `version ${kestrel.kestrel_version}` : "version not reported";
    out.push({ label: "Kestrel", value: [v, kestrel.url].filter(Boolean).join(", ") });
    const kg = obj(kestrel.kg_build);
    if (kg) {
      const commit = typeof kg.git_commit === "string" ? kg.git_commit.slice(0, 8) : null;
      const bits = [kg.kg_version ? `KG ${kg.kg_version}` : null, commit ? `commit ${commit}` : null, kg.build_timestamp ? `built ${String(kg.build_timestamp).slice(0, 10)}` : null, kg.biolink_version ? `Biolink ${kg.biolink_version}` : null]
        .filter(Boolean)
        .join(", ");
      if (bits) out.push({ label: "Knowledge graph build", value: bits });
    }
  }
  if (status?.kgBuild && status.kgBuild !== "unknown") {
    out.push({ label: "KG build (run status)", value: `${status.kgBuild}${status.kgVerified ? ", verified" : ", not verified"}` });
  }
  return out;
}

/** Many-cohort run status and grade. */
export function statusAndGrade(report: Report): { status: string | null; grade: string | null } {
  const s = obj(report.summary);
  const status = typeof report.status === "string" ? report.status : typeof s?.status === "string" ? s.status : null;
  const grade = typeof report.grade === "string" ? report.grade : typeof s?.publication_grade === "string" ? s.publication_grade : null;
  return { status, grade };
}

export function reportCategory(report: Report): string | null {
  return typeof report.category === "string" ? report.category : null;
}
