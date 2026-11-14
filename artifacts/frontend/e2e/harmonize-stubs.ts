import { readFileSync } from "node:fs";
import path from "node:path";
import type { Route } from "@playwright/test";
import type { Stub } from "./helpers";

// A small in-memory stand-in for the /api/harmonize routes, enough to walk the one-page flow end to end with no
// backend: runs that move from queued to complete on successive status polls, items with server-side flags, the
// review items, and exports that carry the headers the page reads. Reports are the committed recordings.

const EXAMPLES = path.resolve(import.meta.dirname, "../../python-api/data/harmonize_examples");
export const TWO_REPORT = JSON.parse(readFileSync(path.join(EXAMPLES, "two_cohort/recording/report.json"), "utf-8"));
export const MANY_REPORT = JSON.parse(readFileSync(path.join(EXAMPLES, "many_cohort/recording/report.json"), "utf-8"));

type Item = {
  ref: string;
  kind: "link" | "group" | "review" | "unresolved";
  arm: "names_only" | "identifier";
  members: Array<{ cohort: string; key: string; name: string | null; chosenKgId: string | null }>;
  detail: Record<string, unknown>;
  suggested: boolean;
};

function twoItems(): Item[] {
  const items: Item[] = [];
  for (const arm of ["names_only", "identifier"] as const) {
    for (const l of TWO_REPORT.arms[arm].links) {
      items.push({
        ref: `link:${arm}:${l.a_key}-${l.b_key}`,
        kind: "link",
        arm,
        members: [
          { cohort: "example_cohort_a", key: l.a_key, name: l.a_name, chosenKgId: l.a_chosen_kg_id },
          { cohort: "example_cohort_b", key: l.b_key, name: l.b_name, chosenKgId: l.b_chosen_kg_id },
        ],
        detail: { basis: l.basis, ambiguous: l.ambiguous, oneToOne: l.one_to_one, aPartners: l.a_partners, bPartners: l.b_partners, origin: "links" },
        suggested: !!l.ambiguous,
      });
    }
  }
  items.push({
    ref: "review:names_only:taurine",
    kind: "review",
    arm: "names_only",
    members: [{ cohort: "example_cohort_a", key: "a21", name: "Taurine", chosenKgId: "RM:0118223" }],
    detail: { vocabulary: "KEGG", code: "C00031", status: "disagree", origin: "review_queue" },
    suggested: true,
  });
  items.push({
    ref: "unresolved:names_only:a30",
    kind: "unresolved",
    arm: "names_only",
    members: [{ cohort: "example_cohort_a", key: "a30", name: "###", chosenKgId: null }],
    detail: { bucket: "unresolved", status: "unresolved", origin: "unresolved_rows" },
    suggested: false,
  });
  return items;
}

function manyItems(): Item[] {
  const items: Item[] = [];
  for (const arm of ["names_only", "identifier"] as const) {
    for (const g of MANY_REPORT.arms[arm].groups) {
      items.push({
        ref: `group:${arm}:${g.node}`,
        kind: "group",
        arm,
        members: g.members.map((m: { cohort: string; key: string; name: string }) => ({ cohort: m.cohort, key: m.key, name: m.name, chosenKgId: g.node })),
        detail: { node: g.node, cohorts: g.cohorts, clean: g.clean, multiplicity: g.multiplicity, broad: g.broad, origin: "groups" },
        suggested: !!g.multiplicity,
      });
    }
  }
  return items;
}

export interface RunDef {
  jobId: string;
  kind: "harmonize_cohorts" | "harmonize_many" | "harmonize_results";
  labels: string[];
  entity: string;
  /** States returned on successive status polls; the last one repeats. */
  states: Array<{ state: string; progress?: Record<string, unknown> | null; reason?: string | null }>;
  report: Record<string, unknown>;
  items: Item[];
}

export function twoRun(jobId = "run-two"): RunDef {
  return {
    jobId,
    kind: "harmonize_cohorts",
    labels: ["example_cohort_a", "example_cohort_b"],
    entity: "biolink:SmallMolecule",
    states: [
      { state: "queued" },
      { state: "running", progress: { function: "harmonize_cohorts", arm: "names_only", cohort: "example_cohort_a", cohorts: [], entitiesDone: 10, entitiesTotal: 30 } },
      { state: "running", progress: { function: "harmonize_cohorts", arm: "identifier", cohort: "example_cohort_b", cohorts: [], entitiesDone: 107, entitiesTotal: 53 } },
      { state: "complete" },
    ],
    report: TWO_REPORT,
    items: twoItems(),
  };
}

export function manyRun(jobId = "run-many"): RunDef {
  return {
    jobId,
    kind: "harmonize_many",
    labels: MANY_REPORT.labels,
    entity: "metabolites",
    states: [{ state: "complete" }],
    report: MANY_REPORT,
    items: manyItems(),
  };
}

export function resultsRun(jobId = "run-jobs"): RunDef {
  const links = TWO_REPORT.arms.names_only.links.slice(0, 4);
  return {
    jobId,
    kind: "harmonize_results",
    labels: ["seed_a", "seed_b"],
    entity: "biolink:SmallMolecule",
    states: [{ state: "complete" }],
    report: {
      schema_version: 1,
      kind: "harmonize_results",
      labels: ["seed_a", "seed_b"],
      entity: "biolink:SmallMolecule",
      name_linking: { enabled: true, decided_by: "user", overridable: true, reason: "Name links are on because they were turned on for this run." },
      arms: {
        names_only: {
          labels: { a: "seed_a", b: "seed_b" },
          links,
          summary: { n_links: 4, n_one_to_one_links: 4, links_by_basis: { node: 4 }, seed_a: { total: 5, linked: 4, unresolved: 0, errors: 0 }, seed_b: { total: 5, linked: 4, unresolved: 1, errors: 0 } },
        },
        identifier: null,
      },
    },
    items: [],
  };
}

/** The status JSON the API gives for a run at a given state. */
function statusJson(run: RunDef, s: RunDef["states"][number]) {
  return {
    jobId: run.jobId,
    state: s.state,
    reason: s.reason ?? null,
    kind: run.kind,
    labels: run.labels,
    entity: run.entity,
    createdAt: "2026-11-14T06:42:30.365501Z",
    stage: s.state === "complete" ? "done" : s.state === "queued" ? "queued" : "mapping",
    cohorts: run.labels.map((label) => ({ label, rows: 30 })),
    entitiesTotal: 53,
    entitiesMapped: 107,
    kgBuild: run.kind === "harmonize_results" ? "unknown" : "2.3.0 (3dd08a5b)",
    kgVerified: run.kind !== "harmonize_results",
    progress: s.progress ?? null,
  };
}

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: body });

/**
 * Stubs for isolate(): every /api/harmonize path for the given runs, plus the entity types, inspect, submit and
 * mapping-job routes. `submit` decides what each submit returns (a run to start, or an error).
 */
export function harmonizeStubs(opts: {
  runs: RunDef[];
  listed?: RunDef[];
  /** inspect answers per uploaded file name. */
  files?: Record<string, { columns: string[]; rowCount: number }>;
  submit?: (kind: "cohorts" | "many" | "example" | "from-jobs", body: string) => { run?: RunDef; status?: number; detail?: string };
}): { stubs: Record<string, Stub>; flags: Map<string, boolean>; started: RunDef[] } {
  const runs = new Map(opts.runs.map((r) => [r.jobId, r]));
  const polls = new Map<string, number>();
  const flags = new Map<string, boolean>(); // organizer overrides
  const started: RunDef[] = [...(opts.listed ?? [])];

  const effective = (i: Item) => (flags.has(i.ref) ? flags.get(i.ref)! : i.suggested);
  const flaggedTotal = (run: RunDef) => run.items.filter(effective).length;
  const current = (run: RunDef, advance: boolean) => {
    const n = polls.get(run.jobId) ?? 0;
    if (advance) polls.set(run.jobId, n + 1);
    return run.states[Math.min(n, run.states.length - 1)];
  };
  const finished = (run: RunDef) => ["complete", "partial"].includes(current(run, false).state);

  const setFlag = (run: RunDef, refs: string[], value: boolean) => {
    for (const ref of refs) {
      const item = run.items.find((i) => i.ref === ref)!;
      if (item.suggested === value) flags.delete(ref);
      else flags.set(ref, value);
    }
  };

  const runRoute = async (route: Route, url: URL) => {
    const parts = url.pathname.replace("/api/harmonize/runs/", "").split("/");
    const run = runs.get(decodeURIComponent(parts[0]));
    if (!run) return json(route, { detail: "Run not found" }, 404);
    const tail = parts.slice(1).join("/");
    const method = route.request().method();
    if (tail === "") return json(route, statusJson(run, current(run, true)));
    if (tail === "cancel") {
      run.states = [{ state: "cancelled", reason: "Cancelled. What was mapped is kept; resume continues it." }, ...run.states.slice(-1)];
      polls.set(run.jobId, 0);
      return json(route, statusJson(run, run.states[0]));
    }
    if (tail === "resume") {
      polls.set(run.jobId, 1);
      return json(route, statusJson(run, { state: "running", progress: { function: "f", arm: "names_only", entitiesDone: 12, entitiesTotal: 30, cohort: "example_cohort_a" } }));
    }
    if (!finished(run)) return json(route, { detail: `Job ${run.jobId} is running (stage mapping); its report is available once it is complete.` }, 409);
    if (tail === "report") return json(route, run.report);
    if (tail === "items") {
      const q = url.searchParams;
      let list = run.items;
      if (q.get("kind")) list = list.filter((i) => i.kind === q.get("kind"));
      if (q.get("arm")) list = list.filter((i) => i.arm === q.get("arm"));
      if (q.get("flagged")) list = list.filter((i) => effective(i) === (q.get("flagged") === "true"));
      const offset = Number(q.get("offset") ?? 0);
      const limit = Number(q.get("limit") ?? 100);
      return json(route, {
        total: list.length,
        flaggedTotal: flaggedTotal(run),
        items: list.slice(offset, offset + limit).map((i) => ({
          ...i, flagged: effective(i), source: flags.has(i.ref) ? "organizer" : "biomapper",
        })),
      });
    }
    if (tail === "flags" && method === "PUT") {
      const body = route.request().postDataJSON() as { refs: string[]; flagged: boolean };
      setFlag(run, body.refs, body.flagged);
      return json(route, { updated: body.refs.length, flaggedTotal: flaggedTotal(run) });
    }
    if (tail === "flags/bulk") {
      const { filter, flagged } = route.request().postDataJSON() as { filter: Record<string, unknown>; flagged: boolean };
      const hit = run.items.filter((i) =>
        (filter.kind === undefined || i.kind === filter.kind) &&
        (filter.arm === undefined || i.arm === filter.arm) &&
        (filter.basis === undefined || i.detail.basis === filter.basis) &&
        (filter.ambiguous === undefined || i.detail.ambiguous === filter.ambiguous));
      setFlag(run, hit.map((i) => i.ref), flagged);
      return json(route, { updated: hit.length, flaggedTotal: flaggedTotal(run) });
    }
    if (tail === "flags/reset") {
      const body = (route.request().postDataJSON() ?? {}) as { refs?: string[] };
      for (const ref of body.refs ?? run.items.map((i) => i.ref)) flags.delete(ref);
      return json(route, { flaggedTotal: flaggedTotal(run) });
    }
    if (tail === "review-items") {
      if (run.kind === "harmonize_results") {
        return json(route, { jobId: run.jobId, total: 0, counts: { row: 0, link: 0 }, skippedNoNode: 0, offset: 0, limit: 25, nextOffset: null, items: [] });
      }
      return json(route, {
        jobId: run.jobId, total: 2, counts: { row: 1, link: 1 }, skippedNoNode: 0, offset: 0, limit: 25, nextOffset: null,
        items: [
          { ref: "lref-1", kind: "link", impact: 2, label: "Creatinine | Creatinine", reasons: ["ambiguous"], engineChoice: null, nodes: ["RM:0028430", "RM:0028430"], nRows: 2, cohorts: ["example_cohort_a", "example_cohort_b"], evidence: "names_captured", suggestion: null },
          { ref: "jref-1", kind: "row", impact: 1, label: "Co", reasons: ["contradicted"], engineChoice: "RM:0051008", nodes: ["RM:0051008"], nRows: 1, cohorts: ["example_cohort_a"], evidence: "present", suggestion: null },
        ],
      });
    }
    if (tail.startsWith("review-items/")) {
      const ref = decodeURIComponent(tail.slice("review-items/".length));
      if (ref === "jref-1") {
        return json(route, {
          ref, kind: "row", jobId: run.jobId, impact: 1, nextStep: "Ask an expert whether Co is cobalt.",
          row: { name: "Co", category: "biolink:SmallMolecule", engineChoice: "RM:0051008", certificateState: "contradicted", candidatesStatus: "not_captured", candidatesReason: "the engine sent no candidates", rows: [{ cohort: "example_cohort_a", key: "a27", name: "Co" }], nRows: 1, cohorts: ["example_cohort_a"] },
        });
      }
      return json(route, {
        ref, kind: "link", jobId: run.jobId, impact: 2, nextStep: "Check both Creatinine rows.",
        link: {
          linkKind: "ambiguous", basis: "node", question: "Are a13 and a14 the same analyte?", nRowPairs: 2,
          a: { node: "RM:0028430", nodeName: "Creatinine", rows: [{ cohort: "example_cohort_a", key: "a13", name: "Creatinine" }], nRows: 1, certificateStates: { corroborated: 1 }, identifiers: { HMDB: ["HMDB0000562"] } },
          b: { node: "RM:0028430", nodeName: "Creatinine", rows: [{ cohort: "example_cohort_b", key: "b13", name: "Creatinine" }], nRows: 1, certificateStates: { corroborated: 1 }, identifiers: { HMDB: ["HMDB0000562"] } },
        },
      });
    }
    if (tail === "export") {
      const table = url.searchParams.get("table")!;
      const format = url.searchParams.get("format")!;
      if (table === "eitl_pairs" && format === "tsv") {
        return json(route, { detail: "The EITL pairs file is CSV or JSON: the expert-in-the-loop upload does not read TSV." }, 400);
      }
      const name = `${run.kind}_${run.labels.join("_")}_${table}.${format}`;
      const headers: Record<string, string> = { "Content-Disposition": `attachment; filename="${name}"` };
      let body: string;
      if (table === "eitl_pairs") {
        const flaggedLinks = run.items.filter((i) => effective(i) && (i.kind === "link" || i.kind === "group"));
        const skipped = run.items.filter((i) => effective(i) && (i.kind === "review" || i.kind === "unresolved")).length;
        headers["X-Harmonize-Skipped-One-Sided"] = String(skipped);
        const pairs = flaggedLinks.map((i) => ({
          source_text: i.members[0].name, source_id: i.members[0].key, source_dataset: i.members[0].cohort,
          target_text: i.members[1]?.name, target_id: i.members[1]?.key, target_dataset: i.members[1]?.cohort,
          pair_type: run.entity, resolution_layer: "unspecified",
        }));
        body = format === "json" ? JSON.stringify(pairs) : "source_text,source_id\n";
      } else {
        body = format === "json" ? "[]" : "ref,arm,flagged,flag_source,suggested\n";
      }
      return route.fulfill({
        status: 200, headers: { ...headers, "Access-Control-Expose-Headers": "*" },
        contentType: format === "json" ? "application/json" : "text/csv", body,
      });
    }
    return json(route, { detail: `unstubbed ${tail}` }, 500);
  };

  const submit = (kind: "cohorts" | "many" | "example" | "from-jobs") => async (route: Route) => {
    const out = opts.submit?.(kind, route.request().postData() ?? "") ?? {};
    if (out.detail) return json(route, { detail: out.detail }, out.status ?? 400);
    const run = out.run!;
    runs.set(run.jobId, run);
    started.unshift(run);
    return json(route, statusJson(run, run.states[0]));
  };

  const stubs: Record<string, Stub> = {
    "/api/discovery/entity-types": [
      { type: "biolink:SmallMolecule", aliases: ["lipid", "metabolite"], defaultPrefixes: ["HMDB", "KEGG", "CHEBI"] },
      { type: "biolink:Protein", aliases: ["protein"], defaultPrefixes: ["UniProtKB"] },
      { type: "biolink:Activity", aliases: [], defaultPrefixes: [] },
    ],
    "/api/harmonize/inspect": async (route: Route) => {
      // Answer with the header the test declared for that file name (the name is in the multipart body).
      const raw = route.request().postDataBuffer()?.toString("utf-8") ?? "";
      const name = /filename="([^"]+)"/.exec(raw)?.[1] ?? "";
      const known = opts.files?.[name];
      if (!known) return json(route, { detail: `'${name}' is not a supported cohort file. Upload a .csv, .tsv or .txt file.` }, 400);
      return json(route, known);
    },
    "/api/harmonize/cohorts": submit("cohorts"),
    "/api/harmonize/many": submit("many"),
    "/api/harmonize/example": submit("example"),
    "/api/harmonize/from-jobs": submit("from-jobs"),
    "/api/harmonize/runs": async (route: Route) =>
      json(route, started.map((r) => statusJson(r, current(r, false)))),
    "/api/jobs": [
      { jobId: "job-a", displayName: "Panel A", status: "complete", total: 5, completed: 5, errorCount: 0, env: "production", createdAt: 1_700_000_000, updatedAt: 1_700_000_100 },
      { jobId: "job-b", displayName: "Panel B", status: "complete", total: 5, completed: 5, errorCount: 0, env: "production", createdAt: 1_700_000_200, updatedAt: 1_700_000_300 },
      { jobId: "job-c", displayName: "Still mapping", status: "processing", total: 5, completed: 2, errorCount: 0, env: "production", createdAt: 1_700_000_400, updatedAt: 1_700_000_500 },
    ],
    "/api/jobs/job-a": { jobId: "job-a", displayName: "Panel A", status: "complete", total: 5, completed: 5, errorCount: 0, env: "production", createdAt: 1, updatedAt: 1, results: [], config: { entity_type: "biolink:SmallMolecule" } },
    "/api/jobs/job-b": { jobId: "job-b", displayName: "Panel B", status: "complete", total: 5, completed: 5, errorCount: 0, env: "production", createdAt: 1, updatedAt: 1, results: [], config: { entity_type: "biolink:SmallMolecule" } },
  };
  for (const run of opts.runs) {
    for (const tail of ["", "/cancel", "/resume", "/report", "/items", "/flags", "/flags/bulk", "/flags/reset", "/review-items", "/review-items/lref-1", "/review-items/jref-1", "/export"]) {
      stubs[`/api/harmonize/runs/${run.jobId}${tail}`] = runRoute;
    }
  }
  return { stubs, flags, started };
}
