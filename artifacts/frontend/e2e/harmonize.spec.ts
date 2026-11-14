import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { goto, isolate } from "./helpers";

// The harmonization workbench against a stubbed /api/harmonize: a small in-memory backend that keeps runs, run
// progress and flags, and answers with the shapes the Python API sends. Reports are the recorded example runs
// committed with the backend, so the screen reads real report.json content.

const EXAMPLES = path.resolve(import.meta.dirname, "../../python-api/data/harmonize_examples");
const TWO_REPORT = JSON.parse(readFileSync(path.join(EXAMPLES, "two_cohort", "recording", "report.json"), "utf-8"));
const MANY_REPORT = JSON.parse(readFileSync(path.join(EXAMPLES, "many_cohort", "recording", "report.json"), "utf-8"));

type Item = {
  ref: string;
  kind: "link" | "group" | "review" | "unresolved";
  arm: "names_only" | "identifier";
  members: { cohort: string; key: string; name: string | null; chosenKgId: string | null }[];
  detail: Record<string, unknown>;
  suggested: boolean;
  flagged: boolean;
  source: "biomapper" | "organizer";
};

const A = "example_cohort_a";
const B = "example_cohort_b";
const m = (cohort: string, key: string, name: string, node: string | null = null) => ({ cohort, key, name, chosenKgId: node });

function twoCohortItems(extra = 0): Item[] {
  const base: Omit<Item, "flagged" | "source">[] = [
    { ref: "link:names_only:glucose", kind: "link", arm: "names_only", members: [m(A, "a01", "Glucose", "RM:1"), m(B, "b01", "D-Glucose", "RM:1")], detail: { basis: "node", ambiguous: false, oneToOne: true, aPartners: 1, bPartners: 1, origin: "links" }, suggested: false },
    { ref: "link:names_only:creat13", kind: "link", arm: "names_only", members: [m(A, "a13", "Creatinine", "RM:2"), m(B, "b13", "Creatinine", "RM:2")], detail: { basis: "node", ambiguous: true, oneToOne: false, aPartners: 1, bPartners: 2, origin: "links" }, suggested: true },
    { ref: "link:names_only:creat14", kind: "link", arm: "names_only", members: [m(A, "a14", "Creatinine", "RM:2"), m(B, "b13", "Creatinine", "RM:2")], detail: { basis: "node", ambiguous: true, oneToOne: false, aPartners: 1, bPartners: 2, origin: "links" }, suggested: true },
    { ref: "review:names_only:taurine", kind: "review", arm: "names_only", members: [m(A, "a21", "Taurine", "RM:3")], detail: { vocabulary: "KEGG", code: "C00031", status: "disagree", origin: "review_queue" }, suggested: true },
    { ref: "unresolved:names_only:a30", kind: "unresolved", arm: "names_only", members: [m(A, "a30", "###")], detail: { bucket: "unresolved", status: "unresolved", origin: "unresolved_rows" }, suggested: false },
    { ref: "link:identifier:glucose", kind: "link", arm: "identifier", members: [m(A, "a01", "Glucose", "HMDB:HMDB0000122"), m(B, "b01", "D-Glucose", "HMDB:HMDB0000122")], detail: { basis: "identifier", ambiguous: false, oneToOne: true, aPartners: 1, bPartners: 1, origin: "links" }, suggested: false },
  ];
  for (let i = 0; i < extra; i++) {
    base.push({ ref: `link:identifier:extra${i}`, kind: "link", arm: "identifier", members: [m(A, `x${i}`, `Compound ${i}`), m(B, `y${i}`, `Compound ${i}`)], detail: { basis: "node", ambiguous: false, aPartners: 1, bPartners: 1, origin: "links" }, suggested: false });
  }
  return base.map((i) => ({ ...i, flagged: i.suggested, source: "biomapper" }));
}

function manyItems(): Item[] {
  const C = (x: string) => `example_cohort_${x}`;
  const raw: Omit<Item, "flagged" | "source">[] = [
    { ref: "group:names_only:leucine", kind: "group", arm: "names_only", members: [m(C("a"), "a06", "Leucine"), m(C("a"), "a07", "L-Leucine"), m(C("b"), "b05", "Leucine")], detail: { node: "RM:9", cohorts: [C("a"), C("b")], clean: false, multiplicity: true, broad: false, origin: "groups" }, suggested: true },
    { ref: "group:names_only:glucose", kind: "group", arm: "names_only", members: [m(C("a"), "a01", "Glucose"), m(C("b"), "b01", "D-Glucose"), m(C("c"), "c01", "Glucose")], detail: { node: "RM:1", cohorts: [C("a"), C("b"), C("c")], clean: true, multiplicity: false, broad: false, origin: "groups" }, suggested: false },
    { ref: "review:identifier:crossnode", kind: "review", arm: "identifier", members: [m(C("c"), "c06", "Creatinine")], detail: { nodeA: "RM:0028430", nodeB: "RM:0117395", nRowPairs: 4, origin: "cross_node" }, suggested: true },
    { ref: "unresolved:names_only:c16", kind: "unresolved", arm: "names_only", members: [m(C("c"), "c16", "%%%")], detail: { bucket: "unresolved", origin: "not_grouped" }, suggested: false },
  ];
  return raw.map((i) => ({ ...i, flagged: i.suggested, source: "biomapper" }));
}

interface FakeRun {
  status: Record<string, unknown>;
  report: unknown;
  items: Item[];
  /** Progress updates still to play before the run completes (one per status poll). */
  pending: { arm: string; done: number; total: number; cohort?: string | null; cohorts?: string[] }[];
}

class FakeBackend {
  runs: FakeRun[] = [];
  calls: { method: string; path: string; body?: unknown; search?: string }[] = [];
  /** Error answers for submit routes, by path. */
  failures: Record<string, { status: number; detail: string }> = {};
  nextId = 1;

  addRun(kind: string, labels: string[], report: unknown, items: Item[], pending: FakeRun["pending"] = [], entity = "metabolites") {
    const jobId = `run${this.nextId++}`;
    const run: FakeRun = {
      status: {
        jobId, kind, labels, entity, createdAt: new Date(Date.UTC(2026, 10, 13, 10, this.nextId)).toISOString(),
        state: pending.length ? "queued" : "complete", reason: null, stage: pending.length ? "queued" : "done",
        cohorts: labels.map((l) => ({ label: l, rows: 30 })), entitiesTotal: 53, entitiesMapped: 107, kgBuild: "2.3.0 (3dd08a5b)", kgVerified: true, progress: null,
      },
      report, items, pending,
    };
    this.runs.unshift(run);
    return run;
  }

  find(id: string) {
    return this.runs.find((r) => r.status.jobId === id);
  }

  tick(run: FakeRun) {
    const state = run.status.state;
    if (state !== "queued" && state !== "running") return;
    const next = run.pending.shift();
    if (next) {
      run.status = { ...run.status, state: "running", stage: "mapping", progress: { function: "harmonize_cohorts", arm: next.arm, cohort: next.cohort ?? null, cohorts: next.cohorts ?? [], entitiesDone: next.done, entitiesTotal: next.total } };
    } else {
      run.status = { ...run.status, state: "complete", stage: "done", progress: null };
    }
  }

  async handle(route: Route) {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname.replace(/^\/api\/harmonize/, "");
    const method = req.method();
    let body: unknown;
    try {
      body = req.postDataJSON();
    } catch {
      body = undefined;
    }
    this.calls.push({ method, path: p, body, search: url.search });
    const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => route.fulfill({ status, json: data, headers });
    const fail = this.failures[p];
    if (fail && method === "POST") return json({ detail: fail.detail }, fail.status);

    if (p === "/runs" && method === "GET") return json(this.runs.map((r) => r.status));
    if (p === "/example" && method === "POST") {
      const kind = (body as { kind: string }).kind;
      const run = kind === "two_cohort"
        ? this.addRun("harmonize_cohorts", [A, B], TWO_REPORT, twoCohortItems(), [
            { arm: "names_only", done: 10, total: 30, cohort: A },
            { arm: "names_only", done: 30, total: 30, cohort: B },
            { arm: "identifier", done: 107, total: 53, cohort: B },
          ])
        : this.addRun("harmonize_many", ["a", "b", "c", "d", "e"].map((x) => `example_cohort_${x}`), MANY_REPORT, manyItems(), [{ arm: "names_only", done: 5, total: 49, cohorts: ["example_cohort_a", "example_cohort_b", "example_cohort_c", "example_cohort_d", "example_cohort_e"] }]);
      return json(run.status);
    }
    if (p === "/inspect" && method === "POST") {
      const raw = req.postData() ?? "";
      if (raw.includes('filename="big.tsv"')) return json({ detail: "'big.tsv' is not UTF-8 text." }, 400);
      return json({ columns: ["row_id", "Analyte", "HMDB_ID", "kegg"], rowCount: 30 });
    }
    if ((p === "/cohorts" || p === "/many") && method === "POST") {
      const run = this.addRun(p === "/cohorts" ? "harmonize_cohorts" : "harmonize_many", ["x", "y"], TWO_REPORT, twoCohortItems(), [{ arm: "names_only", done: 1, total: 30, cohort: "x" }]);
      return json(run.status);
    }
    if (p === "/from-jobs" && method === "POST") {
      const run = this.addRun("harmonize_results", ["seed_a", "seed_b"], { ...TWO_REPORT, kind: "harmonize_results", arms: { names_only: (TWO_REPORT as { arms: { names_only: unknown } }).arms.names_only, identifier: null } }, twoCohortItems().filter((i) => i.arm === "names_only" && i.kind !== "review"));
      return json(run.status);
    }

    const match = /^\/runs\/([^/]+)(\/.*)?$/.exec(p);
    if (!match) return json({ detail: "Not found" }, 404);
    const run = this.find(match[1]);
    if (!run) return json({ detail: "Run not found" }, 404);
    const sub = match[2] ?? "";
    const finished = run.status.state === "complete" || run.status.state === "partial";
    const notYet = () => json({ detail: "This job is still running; its report is available once it is complete." }, 409);

    if (sub === "" && method === "GET") {
      this.tick(run);
      return json(run.status);
    }
    if (sub === "/cancel") {
      run.status = { ...run.status, state: "cancelled", reason: "Cancelled. What was mapped is kept; resume continues it.", progress: null };
      return json(run.status);
    }
    if (sub === "/resume") {
      run.status = { ...run.status, state: "queued", reason: null };
      return json(run.status);
    }
    if (!finished) return notYet();
    if (sub === "/report") return json(run.report);
    if (sub === "/items") {
      const q = url.searchParams;
      let list = run.items;
      if (q.get("kind")) list = list.filter((i) => i.kind === q.get("kind"));
      if (q.get("arm")) list = list.filter((i) => i.arm === q.get("arm"));
      if (q.get("flagged")) list = list.filter((i) => String(i.flagged) === q.get("flagged"));
      const offset = Number(q.get("offset") ?? 0);
      const limit = Number(q.get("limit") ?? 100);
      return json({ total: list.length, flaggedTotal: run.items.filter((i) => i.flagged).length, items: list.slice(offset, offset + limit) });
    }
    const flaggedTotal = () => run.items.filter((i) => i.flagged).length;
    const setFlag = (i: Item, flagged: boolean) => {
      i.flagged = flagged;
      i.source = flagged === i.suggested ? "biomapper" : "organizer";
    };
    if (sub === "/flags" && method === "PUT") {
      const { refs, flagged } = body as { refs: string[]; flagged: boolean };
      const chosen = run.items.filter((i) => refs.includes(i.ref));
      chosen.forEach((i) => setFlag(i, flagged));
      return json({ updated: chosen.length, flaggedTotal: flaggedTotal() });
    }
    if (sub === "/flags/bulk") {
      const { filter, flagged } = body as { filter: Record<string, unknown>; flagged: boolean };
      const chosen = run.items.filter((i) => (!filter.kind || i.kind === filter.kind) && (!filter.arm || i.arm === filter.arm) && (filter.basis === undefined || i.detail.basis === filter.basis) && (filter.ambiguous === undefined || i.detail.ambiguous === filter.ambiguous));
      chosen.forEach((i) => setFlag(i, flagged));
      return json({ updated: chosen.length, flaggedTotal: flaggedTotal() });
    }
    if (sub === "/flags/reset") {
      const refs = (body as { refs?: string[] } | undefined)?.refs;
      run.items.filter((i) => !refs || refs.includes(i.ref)).forEach((i) => setFlag(i, i.suggested));
      return json({ flaggedTotal: flaggedTotal() });
    }
    if (sub === "/export") {
      const table = url.searchParams.get("table");
      const format = url.searchParams.get("format");
      if (table === "eitl_pairs" && format === "tsv") return json({ detail: "The EITL pairs file is CSV or JSON: the expert-in-the-loop upload does not read TSV." }, 400);
      const flagged = run.items.filter((i) => i.flagged);
      const pairs = flagged.filter((i) => i.kind === "link").map((i) => ({ source_text: i.members[0].name, source_id: i.members[0].key, source_dataset: i.members[0].cohort, target_text: i.members[1].name, target_id: i.members[1].key, target_dataset: i.members[1].cohort, pair_type: "metabolites", resolution_layer: "unspecified" }));
      const headers: Record<string, string> = { "Content-Disposition": `attachment; filename="harmonize_cohorts_${A}_${B}_${table}.${format}"` };
      if (table === "eitl_pairs") headers["X-Harmonize-Skipped-One-Sided"] = String(flagged.length - pairs.length);
      if (format === "json") return route.fulfill({ status: 200, contentType: "application/json", headers, body: JSON.stringify(table === "eitl_pairs" ? pairs : []) });
      return route.fulfill({ status: 200, contentType: format === "csv" ? "text/csv" : "text/tab-separated-values", headers, body: "ref,arm,flagged,flag_source,suggested\n" });
    }
    if (sub === "/review-items") {
      if (run.status.kind === "harmonize_results") return json({ jobId: run.status.jobId, total: 0, counts: { row: 0, link: 0 }, skippedNoNode: 0, offset: 0, limit: 25, nextOffset: null, items: [] });
      return json({
        jobId: run.status.jobId, total: 2, counts: { row: 1, link: 1 }, skippedNoNode: 0, offset: 0, limit: 50, nextOffset: null,
        items: [
          { ref: "lref-1", kind: "link", impact: 2, label: "Creatinine | Creatinine", reasons: ["ambiguous"], engineChoice: null, nodes: ["RM:2", "RM:2"], nRows: 2, cohorts: [A, B], evidence: "names_captured", suggestion: null },
          { ref: "jref-1", kind: "row", impact: 1, label: "CO", reasons: ["contradicted"], engineChoice: "RM:0051008", nodes: [], nRows: 1, cohorts: [B], evidence: "present", suggestion: null },
        ],
      });
    }
    if (sub.startsWith("/review-items/")) {
      const ref = decodeURIComponent(sub.slice("/review-items/".length));
      if (ref === "jref-1") {
        return json({ ref, kind: "row", jobId: run.status.jobId, impact: 1, suggestion: null, nextStep: "Ask an expert.", link: null, row: { name: "CO", category: "biolink:SmallMolecule", weakTrigger: "contradicted", engineChoice: "RM:0051008", certificateState: "contradicted", rows: [{ cohort: B, key: "b26", name: "CO" }], nRows: 1, cohorts: [B], candidatesStatus: "present", candidatesReason: "Captured at review time." } });
      }
      return json({ ref, kind: "link", jobId: run.status.jobId, impact: 2, suggestion: null, nextStep: "Ask an expert.", row: null, link: { linkKind: "two_cohort", basis: "node", bases: ["node"], reviewReasons: ["ambiguous"], nRowPairs: 1, cohorts: [A, B], question: "Is this pair the same entity?", a: { node: "RM:2", nodeName: "Creatinine", nodeNameStatus: "ok", rows: [{ cohort: A, key: "a13", name: "Creatinine" }], nRows: 1, certificateStates: { corroborated: 1 }, identifiers: { HMDB: ["HMDB0000562"] } }, b: { node: "RM:2", nodeName: "Creatinine", nodeNameStatus: "ok", rows: [{ cohort: B, key: "b13", name: "Creatinine" }], nRows: 1, certificateStates: { corroborated: 1 }, identifiers: { HMDB: ["HMDB0000562"] } } } });
    }
    return json({ detail: "Not found" }, 404);
  }
}

const FINISHED_JOBS = [
  { jobId: "job-a", displayName: "Panel A", status: "complete", total: 5, completed: 5, errorCount: 0, env: "production", createdAt: 1_700_000_000, updatedAt: 1_700_000_100 },
  { jobId: "job-b", displayName: "Panel B", status: "complete", total: 5, completed: 5, errorCount: 0, env: "production", createdAt: 1_700_000_200, updatedAt: 1_700_000_300 },
  { jobId: "job-c", displayName: "Still mapping", status: "processing", total: 5, completed: 2, errorCount: 0, env: "production", createdAt: 1_700_000_400, updatedAt: 1_700_000_500 },
];

async function setup(page: Page, seed?: (b: FakeBackend) => void) {
  const backend = new FakeBackend();
  seed?.(backend);
  await isolate(page, {
    "/api/jobs": FINISHED_JOBS,
    "/api/jobs/job-a": { ...FINISHED_JOBS[0], results: [], config: { entityType: "biolink:SmallMolecule" } },
    "/api/jobs/job-b": { ...FINISHED_JOBS[1], results: [], config: { entityType: "biolink:SmallMolecule" } },
  });
  // isolate() aborts Clerk's script, and the dev server then raises its runtime-error overlay over the page a
  // moment later. That overlay is a test artifact (no Clerk offline), so remove it; any other overlay stays.
  await page.addInitScript(() => {
    window.setInterval(() => {
      for (const el of Array.from(document.querySelectorAll("vite-error-overlay"))) {
        const text = el.shadowRoot?.textContent ?? "";
        if (text.includes("failed_to_load_clerk_js") || text.includes("Failed to load Clerk")) el.remove();
      }
    }, 50);
  });
  // Registered after isolate, so it wins for every harmonization call.
  await page.route("**/api/harmonize/**", (route) => backend.handle(route));
  await page.route("**/api/harmonize/runs", (route) => backend.handle(route));
  return backend;
}

test.describe("harmonization workbench @app", () => {
  test("rail entry opens the screen; a first visit offers the examples", async ({ page }) => {
    await setup(page);
    await goto(page, "/");
    await page.getByTestId("app-nav").getByRole("link", { name: "Harmonize" }).click();
    await expect(page).toHaveURL(/\/harmonize$/);
    await expect(page.getByText("Harmonize cohorts")).toBeVisible();
    await expect(page.getByRole("button", { name: "Run the two-cohort example" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Run the many-cohort example" })).toBeVisible();
  });

  test("two-cohort example: progress per arm, then the item table, flags, review and exports", async ({ page }) => {
    const backend = await setup(page);
    await goto(page, "/harmonize");
    await page.getByRole("button", { name: "Run the two-cohort example" }).click();

    // Progress: the arm and its own count, the cohort being mapped, never above 100 percent.
    await expect(page.getByTestId("progress-arm")).toHaveText(/Names only/);
    await expect(page.getByTestId("progress-cohort")).toContainText(/example_cohort_/);
    await expect(page.getByTestId("progress-count")).toContainText(/of 53 entities \(100%\)|of 30 entities/);
    await expect(page.getByText("107 of 53")).toHaveCount(0);

    // Finished: the table is the page.
    await expect(page.getByTestId("items-table")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("items-total")).toContainText("6 items");
    await expect(page.getByTestId("flagged-total")).toContainText("3 flagged");
    await expect(page.getByTestId("arm-strip")).toContainText("Names-only arm");
    await expect(page.getByTestId("arm-strip")).toContainText("Identifier arm");
    await expect(page.getByTestId("diff-strip")).toContainText("Both arms 29");

    // Flag a one-to-one link: the total rises by one and the source reads organizer.
    const glucose = page.getByRole("button", { name: "Flag One-to-one link, names only arm: Glucose (a01) / D-Glucose (b01)" });
    await expect(glucose).toHaveAttribute("aria-pressed", "false");
    await glucose.click();
    await expect(page.getByTestId("flagged-total")).toContainText("4 flagged");
    await expect(glucose).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('tr[data-ref="link:names_only:glucose"]')).toContainText("organizer");

    // De-flag one of biomapper's suggestions.
    await page.getByRole("button", { name: "Flag Ambiguous link, names only arm: Creatinine (a13) / Creatinine (b13)" }).click();
    await expect(page.getByTestId("flagged-total")).toContainText("3 flagged");
    await expect(page.locator('tr[data-ref="link:names_only:creat13"]')).toContainText("organizer");

    // Filters go to the server.
    await page.getByLabel("Kind", { exact: true }).selectOption("review");
    await expect(page.getByTestId("items-total")).toContainText("1 item match the filters");
    expect(backend.calls.some((c) => c.path.endsWith("/items") && c.search?.includes("kind=review"))).toBe(true);
    await page.getByRole("button", { name: "Clear filters" }).first().click();
    await page.getByLabel("Flag state").selectOption("true");
    await expect(page.getByTestId("items-total")).toContainText("3 items match the filters");
    await page.getByLabel("Flag state").selectOption("");

    // Bulk: flag every ambiguous link, and see how many matched.
    await page.getByRole("button", { name: "Bulk flag" }).click();
    await page.getByRole("dialog").getByLabel("Ambiguous", { exact: true }).selectOption("true");
    await page.getByRole("button", { name: "Flag matching items", exact: true }).click();
    await expect(page.getByTestId("bulk-result")).toContainText("2 items matched");
    await page.keyboard.press("Escape");

    // Reset all: back to biomapper's suggestion.
    await page.getByRole("button", { name: "Reset all flags" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Reset all flags" }).click();
    await expect(page.getByTestId("flagged-total")).toContainText("3 flagged");
    await expect(page.locator('tr[data-ref="link:names_only:glucose"]')).toContainText("biomapper");

    // Item detail docks beside the table.
    await page.getByRole("button", { name: "Open One-sided identifier check, names only arm: Taurine (a21)" }).click();
    const panel = page.getByTestId("item-panel");
    await expect(panel).toContainText("One-sided identifier check");
    await expect(panel).toContainText("C00031");
    await panel.getByRole("button", { name: "Close Item detail" }).click();

    // Review queue evidence and its detail.
    await page.getByRole("tab", { name: "Review queue evidence" }).click();
    await page.getByRole("button", { name: "CO" }).click();
    await expect(page.getByTestId("review-row-detail")).toContainText("RM:0051008");
    await expect(page.getByTestId("review-row-detail")).toContainText("contradicted");
    await expect(page.getByTestId("review-row-detail")).toContainText("Captured at review time.");
    await page.getByRole("button", { name: "Creatinine | Creatinine" }).first().click();
    await expect(page.getByTestId("review-link-detail")).toContainText("Is this pair the same entity?");

    // Run details: name linking, warnings, pins.
    await page.getByRole("button", { name: "Run details", exact: true }).click();
    await expect(page.getByTestId("name-linking")).toContainText("On");
    await expect(page.getByTestId("warnings-section")).toContainText("KEGG is declared only");
    await expect(page.getByTestId("pins-section")).toContainText("1.9.0");
    await expect(page.getByTestId("excluded-section")).toContainText("No rows were excluded");

    // Exports: the skipped count from the response header, JSON by default, Send to EITL disabled.
    await page.getByRole("button", { name: "Export", exact: true }).click();
    await expect(page.getByTestId("eitl-skipped")).toContainText("1 flagged item left out");
    await expect(page.getByRole("radio", { name: /JSON/ })).toBeChecked();
    await expect(page.getByRole("button", { name: "Send to EITL" })).toBeDisabled();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download EITL pairs (JSON)" }).click();
    expect((await download).suggestedFilename()).toBe(`harmonize_cohorts_${A}_${B}_eitl_pairs.json`);
    await expect(page.getByTestId("eitl-downloaded")).toContainText("1 flagged item was left out");
    const links = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download links as TSV" }).click();
    expect((await links).suggestedFilename()).toBe(`harmonize_cohorts_${A}_${B}_links.tsv`);
  });

  test("many-cohort example: groups with multiplicity, cross-node review and rows not grouped", async ({ page }) => {
    await setup(page);
    await goto(page, "/harmonize");
    await page.getByRole("button", { name: "Run the many-cohort example" }).click();
    await expect(page.getByTestId("progress-cohorts")).toContainText("Mapping 5 cohorts together");
    await expect(page.getByTestId("items-table")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('tr[data-ref="group:names_only:leucine"]')).toContainText("Multiplicity");
    await expect(page.locator('tr[data-ref="review:identifier:crossnode"]')).toContainText("Cross-node review");
    await expect(page.locator('tr[data-ref="unresolved:names_only:c16"]')).toContainText("Unresolved");
    await expect(page.getByTestId("arm-strip")).toContainText("iteration-grade, not for publication");
    await expect(page.getByTestId("diff-strip")).toContainText("Membership changed 2");
    await page.getByRole("button", { name: "Run details", exact: true }).click();
    await expect(page.getByTestId("report-grade")).toHaveText("iteration-grade, not for publication");
  });

  test("a returning user lands on their runs; cancel and resume; unknown runs stay listed", async ({ page }) => {
    const backend = await setup(page, (b) => {
      const gone = b.addRun("harmonize_cohorts", ["old_a", "old_b"], TWO_REPORT, []);
      gone.status = { jobId: gone.status.jobId, state: "unknown", reason: "No such job: its record is gone.", kind: "harmonize_cohorts", labels: ["old_a", "old_b"], entity: "metabolites", createdAt: "2026-11-01T00:00:00Z" };
      b.addRun("harmonize_cohorts", ["live_a", "live_b"], TWO_REPORT, twoCohortItems(), Array.from({ length: 50 }, (_, i) => ({ arm: "names_only", done: i % 30, total: 30, cohort: "live_a" })));
    });
    await goto(page, "/harmonize");
    // The newest run opens by itself.
    await expect(page).toHaveURL(/\/harmonize\/run2$/);
    const list = page.getByTestId("run-list");
    await expect(list).toContainText("old_a and old_b");
    await expect(list).toContainText("Unknown");
    await expect(list).toContainText("No such job: its record is gone.");

    await page.getByRole("button", { name: "Cancel run" }).click();
    await expect(page.getByRole("heading", { level: 1 }).locator("..")).toContainText("Cancelled");
    await expect(page.getByTestId("run-reason")).toContainText("Cancelled. What was mapped is kept");
    await page.getByRole("button", { name: "Resume run" }).click();
    await expect(page.getByTestId("progress-arm")).toBeVisible();

    // Leave and come back: the run is still there, still going.
    await page.getByTestId("app-nav").getByRole("link", { name: "New job" }).click();
    await page.getByTestId("app-nav").getByRole("link", { name: "Harmonize" }).click();
    await expect(page).toHaveURL(/\/harmonize\/run2$/);
    await expect(page.getByTestId("progress-arm")).toBeVisible();
    expect(backend.calls.filter((c) => c.path === "/runs/run2/cancel")).toHaveLength(1);
  });

  test("upload setup: pickers from the file's header, and the API's refusals shown as written", async ({ page }) => {
    const backend = await setup(page);
    await goto(page, "/harmonize");
    await page.getByRole("button", { name: "New run" }).first().click();
    const input = page.getByTestId("harm-file-input");
    await input.setInputFiles([
      { name: "a.tsv", mimeType: "text/tab-separated-values", buffer: Buffer.from("row_id\tAnalyte\tHMDB_ID\tkegg\nr1\tGlucose\tHMDB0000122\tC00031\n") },
      { name: "b.tsv", mimeType: "text/tab-separated-values", buffer: Buffer.from("row_id\tAnalyte\tHMDB_ID\tkegg\nr1\tGlucose\tHMDB0000122\tC00031\n") },
    ]);
    const cards = page.getByTestId("cohort-card");
    await expect(cards).toHaveCount(2);
    await expect(cards.first().getByTestId("cohort-inspect")).toContainText("30 rows · 4 columns: row_id, Analyte, HMDB_ID, kegg");
    const nameSelect = cards.first().getByLabel("Name column");
    await expect(nameSelect).toHaveValue("Analyte");
    expect(await nameSelect.locator("option").allTextContents()).toEqual(["row_id", "Analyte", "HMDB_ID", "kegg"]);
    await expect(cards.first().getByLabel("Key column (optional)")).toHaveValue("row_id");
    await expect(cards.first().getByLabel("Vocabulary in column HMDB_ID of a")).toHaveValue("HMDB");
    await expect(cards.first().getByLabel("Vocabulary in column kegg of a")).toHaveValue("KEGG");

    // Same label on both sides: the server's message, as written.
    await cards.nth(1).getByLabel("Cohort label").fill("a");
    backend.failures["/cohorts"] = { status: 400, detail: "Cohort labels must be distinct (got a, a)." };
    await page.getByRole("button", { name: "Start harmonizing" }).click();
    await expect(page.getByRole("dialog")).toContainText("Cohort labels must be distinct (got a, a).");
    expect(backend.calls.filter((c) => c.path === "/cohorts")).toHaveLength(1);

    // Many cohorts with too many unfinished runs: the 409 message as written.
    await page.getByRole("radio", { name: /Many cohorts/ }).click();
    backend.failures["/many"] = { status: 409, detail: "This session already has 3 unfinished harmonize job(s) (limit 3); jobs run one at a time. Wait for one to finish, or cancel_job it." };
    await page.getByRole("button", { name: "Start harmonizing" }).click();
    await expect(page.getByRole("dialog")).toContainText("This session already has 3 unfinished harmonize job(s) (limit 3)");
    await expect(page.getByRole("checkbox", { name: /Remap all rows/ })).toBeVisible();

    // A file the server refuses at inspect shows its message on the card.
    await input.setInputFiles({ name: "big.tsv", mimeType: "text/tab-separated-values", buffer: Buffer.from("x\n1\n") });
    await expect(cards.nth(2)).toContainText("'big.tsv' is not UTF-8 text.");
  });

  test("finished jobs: only finished jobs can be chosen, the refusal is shown, a good run opens complete", async ({ page }) => {
    const backend = await setup(page);
    await goto(page, "/harmonize");
    await page.getByRole("button", { name: "New run" }).first().click();
    await page.getByRole("tab", { name: "Finished mapping jobs" }).click();
    const jobA = page.getByLabel("Job A", { exact: true });
    await expect(jobA.locator('option[value="job-c"]')).toBeDisabled();
    await jobA.selectOption("job-a");
    await page.getByLabel("Job B", { exact: true }).selectOption("job-b");
    await expect(page.getByLabel("Label for job A")).toHaveValue("Panel_A");
    await expect(page.getByText("Entity type: biolink:SmallMolecule").first()).toBeVisible();
    await page.getByRole("checkbox", { name: /Also link rows by name/ }).check();

    backend.failures["/from-jobs"] = { status: 400, detail: "This job was mapped before harmonizing finished jobs was supported. Map the file again, then harmonize." };
    await page.getByRole("button", { name: "Harmonize these jobs" }).click();
    await expect(page.getByRole("dialog")).toContainText("This job was mapped before harmonizing finished jobs was supported. Map the file again, then harmonize.");
    expect(backend.calls.find((c) => c.path === "/from-jobs")?.body).toEqual({ jobA: "job-a", jobB: "job-b", aLabel: "Panel_A", bLabel: "Panel_B", linkByName: true });

    delete backend.failures["/from-jobs"];
    await page.getByRole("button", { name: "Harmonize these jobs" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByTestId("items-table")).toBeVisible();
    await expect(page.getByTestId("arm-skipped-identifier")).toContainText("Skipped");
    await page.getByRole("tab", { name: "Review queue evidence" }).click();
    await expect(page.getByText("No review queue for this run")).toBeVisible();
  });

  test("a long item list scrolls inside its own box with a visible bar", async ({ page }) => {
    await setup(page, (b) => b.addRun("harmonize_cohorts", [A, B], TWO_REPORT, twoCohortItems(150)));
    await page.setViewportSize({ width: 1280, height: 720 });
    await goto(page, "/harmonize");
    await expect(page.getByTestId("items-table")).toBeVisible();
    await expect(page.getByTestId("items-range")).toContainText("Showing 1 to 100 of 156");
    const box = page.getByTestId("items-scroll");
    const info = await box.evaluate((el) => ({ over: el.scrollHeight > el.clientHeight, cls: el.className, bar: el.offsetWidth - el.clientWidth }));
    expect(info.over).toBe(true);
    expect(info.cls).toContain("scroll-visible");
    expect(info.bar).toBeGreaterThan(0);
    const docScrolls = await page.evaluate(() => document.scrollingElement!.scrollHeight > document.scrollingElement!.clientHeight + 1);
    expect(docScrolls).toBe(false);
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page.getByTestId("items-range")).toContainText("Showing 101 to 156 of 156");
  });
});
