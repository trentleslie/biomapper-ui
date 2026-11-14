import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { goto, isolate, type Stub } from "./helpers";

// The harmonization screen's staged flow, against stubbed /api answers: set up (example, files, finished jobs),
// run (progress, cancel), review and flag, export. The report is the committed two-cohort recording.

const EXAMPLES = path.resolve(import.meta.dirname, "../../python-api/data/harmonize_examples");
const REPORT = JSON.parse(readFileSync(path.join(EXAMPLES, "two_cohort/recording/report.json"), "utf8"));
const JOB = "job0001";
const RUN_BASE = { jobId: JOB, kind: "harmonize_cohorts", labels: ["example_cohort_a", "example_cohort_b"], entity: "metabolites", createdAt: "2026-11-14T06:42:25Z" };
const progress = (arm: string, done: number, total: number) => ({ function: "harmonize_cohorts", arm, cohort: "example_cohort_a", cohorts: [], entitiesDone: done, entitiesTotal: total });

interface Item {
  ref: string;
  kind: string;
  arm: string;
  members: { cohort: string; key: string; name: string | null; chosenKgId: string | null }[];
  detail: Record<string, unknown>;
  suggested: boolean;
  flagged: boolean;
  source: string;
}

function makeItems(): Item[] {
  const link = (ref: string, a: string, b: string, ambiguous: boolean): Item => ({
    ref,
    kind: "link",
    arm: "names_only",
    members: [
      { cohort: "example_cohort_a", key: a, name: `name ${a}`, chosenKgId: "RM:1" },
      { cohort: "example_cohort_b", key: b, name: `name ${b}`, chosenKgId: "RM:1" },
    ],
    detail: { basis: "node", ambiguous, oneToOne: !ambiguous, aPartners: 1, bPartners: ambiguous ? 2 : 1, origin: "links" },
    suggested: ambiguous,
    flagged: ambiguous,
    source: "biomapper",
  });
  return [
    link("link:names_only:1", "a01", "b01", false),
    link("link:names_only:2", "a13", "b13", true),
    {
      ref: "review:names_only:3",
      kind: "review",
      arm: "names_only",
      members: [{ cohort: "example_cohort_a", key: "a21", name: "Taurine", chosenKgId: "RM:2" }],
      detail: { vocabulary: "KEGG", code: "C00031", status: "disagree", origin: "review_queue" },
      suggested: true,
      flagged: true,
      source: "biomapper",
    },
    {
      ref: "unresolved:names_only:4",
      kind: "unresolved",
      arm: "names_only",
      members: [{ cohort: "example_cohort_a", key: "a30", name: "###", chosenKgId: null }],
      detail: { bucket: "unresolved", status: "unresolved", origin: "unresolved_rows" },
      suggested: false,
      flagged: false,
      source: "biomapper",
    },
  ];
}

/** A stateful stand-in for the run, items, flags and export routes of one run. */
function runStubs(states: { state: string; progress: unknown; stage: string }[]) {
  let polls = 0;
  const items = makeItems();
  const flaggedTotal = () => items.filter((i) => i.flagged).length;
  const runNow = () => {
    const s = states[Math.min(polls, states.length - 1)];
    return { ...RUN_BASE, ...s, reason: s.state === "cancelled" ? "Cancelled. What was mapped is kept; resume continues it." : null, cohorts: [{ label: "example_cohort_a", rows: 30 }, { label: "example_cohort_b", rows: 30 }], kgBuild: "2.3.0 (3dd08a5b)", kgVerified: true };
  };
  const stubs: Record<string, Stub> = {
    "/api/harmonize/runs": async (route: Route) => route.fulfill({ json: [runNow()] }),
    [`/api/harmonize/runs/${JOB}`]: async (route: Route) => {
      const body = runNow();
      polls += 1;
      return route.fulfill({ json: body });
    },
    [`/api/harmonize/runs/${JOB}/cancel`]: async (route: Route) => {
      states.splice(0, states.length, { state: "cancelled", progress: progress("names_only", 10, 30), stage: "mapping" });
      polls = 0;
      return route.fulfill({ json: runNow() });
    },
    [`/api/harmonize/runs/${JOB}/report`]: REPORT,
    [`/api/harmonize/runs/${JOB}/review-items`]: { jobId: JOB, total: 1, counts: { row: 1, link: 0 }, skippedNoNode: 0, offset: 0, limit: 25, nextOffset: null, items: [{ ref: "jref-1", kind: "row", impact: 1, label: "###", reasons: ["unresolved"], engineChoice: null, nodes: [], nRows: 1, cohorts: ["example_cohort_a"], evidence: "present" }] },
    [`/api/harmonize/runs/${JOB}/review-items/jref-1`]: { ref: "jref-1", kind: "row", jobId: JOB, impact: 1, row: { name: "###", weakTrigger: "unresolved", engineChoice: null, certificateState: "unavailable", rows: [{ cohort: "example_cohort_a", key: "a30", name: "###" }], nRows: 1, cohorts: ["example_cohort_a"], candidatesStatus: "present", candidatesReason: null }, link: null, nextStep: "" },
    [`/api/harmonize/runs/${JOB}/items`]: async (route: Route, url: URL) => {
      let chosen = items;
      const kind = url.searchParams.get("kind");
      const flagged = url.searchParams.get("flagged");
      if (kind) chosen = chosen.filter((i) => i.kind === kind);
      if (flagged) chosen = chosen.filter((i) => String(i.flagged) === flagged);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 100);
      return route.fulfill({ json: { total: chosen.length, flaggedTotal: flaggedTotal(), items: chosen.slice(offset, offset + limit) } });
    },
    [`/api/harmonize/runs/${JOB}/flags`]: async (route: Route) => {
      const body = route.request().postDataJSON() as { refs: string[]; flagged: boolean };
      for (const i of items) if (body.refs.includes(i.ref)) Object.assign(i, { flagged: body.flagged, source: body.flagged === i.suggested ? "biomapper" : "organizer" });
      return route.fulfill({ json: { updated: body.refs.length, flaggedTotal: flaggedTotal() } });
    },
    [`/api/harmonize/runs/${JOB}/flags/bulk`]: async (route: Route) => {
      const body = route.request().postDataJSON() as { filter: { kind?: string; ambiguous?: boolean }; flagged: boolean };
      const hit = items.filter((i) => (!body.filter.kind || i.kind === body.filter.kind) && (body.filter.ambiguous === undefined || i.detail.ambiguous === body.filter.ambiguous));
      for (const i of hit) Object.assign(i, { flagged: body.flagged, source: body.flagged === i.suggested ? "biomapper" : "organizer" });
      return route.fulfill({ json: { updated: hit.length, flaggedTotal: flaggedTotal() } });
    },
    [`/api/harmonize/runs/${JOB}/flags/reset`]: async (route: Route) => {
      for (const i of items) Object.assign(i, { flagged: i.suggested, source: "biomapper" });
      return route.fulfill({ json: { flaggedTotal: flaggedTotal() } });
    },
    [`/api/harmonize/runs/${JOB}/export`]: async (route: Route, url: URL) => {
      const table = url.searchParams.get("table");
      const format = url.searchParams.get("format");
      const pairs = items.filter((i) => i.flagged && i.kind === "link").length;
      const skipped = items.filter((i) => i.flagged && i.kind !== "link").length;
      const body = format === "json" ? JSON.stringify(Array.from({ length: table === "eitl_pairs" ? pairs : 0 }, () => ({ source_text: "x" }))) : "ref,arm\r\n";
      return route.fulfill({
        status: 200,
        body,
        headers: {
          "Content-Type": format === "json" ? "application/json" : "text/csv",
          "Content-Disposition": `attachment; filename="harmonize_cohorts_example_cohort_a_example_cohort_b_${table}.${format}"`,
          ...(table === "eitl_pairs" ? { "X-Harmonize-Skipped-One-Sided": String(skipped) } : {}),
          "Access-Control-Expose-Headers": "Content-Disposition, X-Harmonize-Skipped-One-Sided",
        },
      });
    },
  };
  return { stubs, items };
}

async function stepState(page: Page, name: string) {
  return page.getByRole("navigation", { name: "Harmonization steps" }).getByLabel(new RegExp(`^Step \\d: ${name}\\.`));
}

test.describe("harmonize @app", () => {
  // isolate() aborts Clerk's script, and a few seconds later the dev server's runtime-error plugin draws an overlay
  // for that over the page. It is an artifact of running without Clerk, not of this screen; these walks are long
  // enough to meet it, so it is removed when it appears. Any other overlay stays.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      // The overlay fills its shadow root after it is attached, so it is checked on a short timer.
      window.setInterval(() => {
        for (const el of Array.from(document.querySelectorAll("vite-error-overlay"))) {
          if (/clerk/i.test(el.shadowRoot?.textContent ?? "")) el.remove();
        }
      }, 100);
    });
  });

  test("the nav entry opens the staged flow, and an example run goes from progress to review to export", async ({ page }) => {
    // The run is polled every 2 s through three states before the review stage opens.
    test.setTimeout(90_000);
    const states = [
      { state: "running", progress: progress("names_only", 5, 30), stage: "mapping" },
      { state: "running", progress: progress("identifier", 30, 20), stage: "mapping" },
      { state: "complete", progress: progress("review", 3, 3), stage: "done" },
    ];
    const { stubs } = runStubs(states);
    let runsListed = false;
    await isolate(page, {
      ...stubs,
      "/api/harmonize/runs": async (route: Route) => route.fulfill({ json: runsListed ? [] : [] }),
      "/api/harmonize/example": async (route: Route) => {
        expect(route.request().postDataJSON()).toEqual({ kind: "two_cohort" });
        runsListed = true;
        return route.fulfill({ json: { ...RUN_BASE, state: "queued", stage: "queued" } });
      },
    });
    await goto(page, "/");
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Harmonize cohorts" }).click();
    await expect(page).toHaveURL(/\/harmonize$/);
    await expect(page.getByRole("heading", { name: "Harmonize cohorts", level: 1 })).toBeVisible();
    await expect(await stepState(page, "Set up cohorts")).toHaveAttribute("aria-current", "step");
    await expect(await stepState(page, "Review and flag")).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByText("No runs yet")).toBeVisible();

    await page.getByRole("button", { name: "Run the two-cohort example" }).click();
    await expect(page).toHaveURL(new RegExp(`/harmonize/runs/${JOB}/run$`));
    const bar = page.getByRole("progressbar", { name: "Names-only arm progress" });
    await expect(bar).toHaveAttribute("aria-valuetext", "5 of 30 entities");
    // Progress changes every poll, so it sits outside every live region; the state is announced.
    const inLiveRegion = (el: Element) => !!el.closest('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"]');
    expect(await page.getByTestId("arm-progress").evaluate(inLiveRegion)).toBe(false);
    expect(await page.getByTestId("cohort-progress").evaluate(inLiveRegion)).toBe(false);
    await expect(page.getByTestId("run-live")).toHaveAttribute("aria-live", "polite");
    await expect(page.getByTestId("run-live")).toContainText("Running");
    await expect(page.getByText("Mapping cohort: example_cohort_a")).toBeVisible();
    // A later update past its total still reads 100 percent at most.
    await expect(page.getByText("20 of 20 entities (100%)")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("link", { name: "Review results" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("run-state").first()).toHaveText("Complete");

    await page.getByRole("link", { name: "Review results" }).click();
    await expect(page).toHaveURL(new RegExp(`/harmonize/runs/${JOB}/review$`));
    await expect(page.getByTestId("arm-names_only")).toContainText("Links");
    await expect(page.getByTestId("arm-identifier")).toContainText("Ambiguous");
    await expect(page.getByTestId("name-linking")).toContainText("Name links are on because the category is biolink:SmallMolecule.");
    await expect(page.getByTestId("warnings")).toContainText("KEGG is declared only for 'example_cohort_a'");
    await expect(page.getByTestId("excluded-none")).toContainText("None excluded");
    await expect(page.getByTestId("pins")).toContainText("1.9.0");

    await page.getByRole("tab", { name: "Results by arm" }).click();
    await expect(page.getByTestId("links-table")).toContainText("Creatinine");
    await expect(page.getByTestId("unresolved-table")).toContainText("a30");

    await page.getByRole("tab", { name: "Review queue" }).click();
    await expect(page.getByTestId("review-queue-table")).toContainText("Taurine");
    await page.getByRole("button", { name: "Open review item ###" }).click();
    await expect(page.getByTestId("review-item-detail")).toContainText("Certificate state");
    await expect(page.getByTestId("review-item-detail")).toContainText("unavailable");
    await page.keyboard.press("Escape");

    await page.getByRole("tab", { name: "Flag items" }).click();
    const totals = page.getByTestId("item-totals");
    await expect(totals).toContainText("4 items");
    await expect(totals).toContainText("2 flagged in this run");
    // Flag an unflagged link: the total rises by one and its source reads Organizer.
    await page.getByRole("checkbox", { name: /^Flag: Link, example_cohort_a a01/ }).click();
    await expect(totals).toContainText("3 flagged in this run");
    await expect(page.getByTestId("item-row").first()).toContainText("Organizer");
    // De-flag biomapper's own suggestion.
    await page.getByRole("checkbox", { name: /^Flagged: Link, example_cohort_a a13/ }).click();
    await expect(totals).toContainText("2 flagged in this run");
    // Filter by kind.
    await page.getByRole("combobox", { name: "Kind", exact: true }).click();
    await page.getByRole("option", { name: "Review entries" }).click();
    await expect(totals).toContainText("1 item match these filters");
    // Bulk: clear every ambiguous link, then reset everything to biomapper's suggestion.
    await page.getByRole("combobox", { name: "Ambiguous" }).click();
    await page.getByRole("option", { name: "Ambiguous only" }).click();
    await page.getByRole("button", { name: "Flag matching items" }).click();
    await expect(page.getByTestId("bulk-result")).toContainText("1 item matched");
    await page.getByRole("button", { name: "Reset all flags" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Reset all flags" }).click();
    await expect(page.getByTestId("flag-change")).toContainText("2 items flagged in this run");

    await page.getByRole("link", { name: "Continue to export" }).click();
    await expect(page).toHaveURL(new RegExp(`/harmonize/runs/${JOB}/export$`));
    await expect(page.getByRole("radio", { name: "JSON (recommended)" })).toBeChecked();
    await expect(page.getByRole("button", { name: "Send to EITL" })).toBeDisabled();
    await expect(page.getByTestId("eitl-skipped")).toContainText("1 flagged item is left out");
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download EITL pairs (JSON)" }).click();
    expect((await download).suggestedFilename()).toBe("harmonize_cohorts_example_cohort_a_example_cohort_b_eitl_pairs.json");
    for (const table of ["links", "groups", "review", "unresolved"]) {
      for (const format of ["CSV", "TSV", "JSON"]) {
        await expect(page.getByRole("button", { name: `Download ${table} table as ${format}` })).toBeVisible();
      }
    }
    const tsv = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download links table as TSV" }).click();
    expect((await tsv).suggestedFilename()).toBe("harmonize_cohorts_example_cohort_a_example_cohort_b_links.tsv");

    // Earlier stages stay reachable.
    await page.getByRole("navigation", { name: "Harmonization steps" }).getByRole("link", { name: /Set up cohorts/ }).click();
    await expect(page.getByRole("heading", { name: "How this run was set up" })).toBeVisible();
    await expect(page.getByText("a.tsv")).toBeVisible();
  });

  test("cancel a running run, then come back to it from the runs list", async ({ page }) => {
    const { stubs } = runStubs([{ state: "running", progress: progress("names_only", 5, 30), stage: "mapping" }]);
    await isolate(page, stubs);
    await goto(page, "/harmonize");
    await expect(page.getByTestId("runs-list")).toContainText("1 still going");
    await page.getByRole("link", { name: /^Open running run: example_cohort_a, example_cohort_b/ }).click();
    await expect(page).toHaveURL(new RegExp(`/harmonize/runs/${JOB}/run$`));
    await page.getByRole("button", { name: "Cancel run" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel run" }).click();
    await expect(page.getByTestId("run-state").first()).toHaveText("Cancelled");
    await expect(page.getByTestId("run-reason")).toContainText("Cancelled. What was mapped is kept; resume continues it.");
    await expect(page.getByRole("button", { name: "Resume run" })).toBeVisible();
    // Review is locked until the run finishes; asking for it shows the progress instead.
    await goto(page, `/harmonize/runs/${JOB}/review`);
    await expect(page.getByText("Review and flag opens when the run is complete")).toBeVisible();
  });

  test("set up two cohort files: the header fills the pickers and the package's message shows as written", async ({ page }) => {
    let submitted: string | null = null;
    await isolate(page, {
      "/api/harmonize/runs": [],
      "/api/discovery/entity-types": [{ type: "biolink:SmallMolecule", aliases: ["metabolite"], defaultPrefixes: ["HMDB", "KEGG"] }],
      "/api/harmonize/inspect": async (route: Route) => {
        const body = route.request().postDataBuffer()?.toString() ?? "";
        const big = body.includes("big.tsv");
        if (big) return route.fulfill({ status: 400, json: { detail: "'big.tsv' is larger than the 50 MB limit." } });
        return route.fulfill({ json: { columns: ["row_key", "Analyte Name", "HMDB_ID", "weird col"], rowCount: 12 } });
      },
      "/api/harmonize/cohorts": async (route: Route) => {
        submitted = route.request().postDataBuffer()?.toString() ?? "";
        return route.fulfill({ status: 400, json: { detail: "Cohort labels must be distinct (got same, same)." } });
      },
    });
    await goto(page, "/harmonize");
    const file = (name: string) => ({ name, mimeType: "text/tab-separated-values", buffer: Buffer.from("row_key\tAnalyte Name\tHMDB_ID\tweird col\n1\tGlucose\tHMDB0000122\tx\n") });
    await page.getByLabel("Choose file for Cohort A", { exact: true }).first().setInputFiles(file("same.tsv"));
    await expect(page.getByTestId("inspect-summary").first()).toContainText("12 rows, 4 columns: row_key, Analyte Name, HMDB_ID, weird col");
    await expect(page.getByRole("combobox", { name: "Name column for Cohort A" })).toHaveText("Analyte Name");
    await expect(page.getByRole("combobox", { name: "Vocabulary in column HMDB_ID of Cohort A" })).toHaveValue("HMDB");
    await page.getByRole("combobox", { name: "Key column for Cohort A" }).click();
    await expect(page.getByRole("option")).toHaveText(["No key column", "row_key", "Analyte Name", "HMDB_ID", "weird col"]);
    await page.getByRole("option", { name: "row_key" }).click();

    await page.getByLabel("Choose file for Cohort B", { exact: true }).first().setInputFiles(file("big.tsv"));
    await expect(page.getByRole("alert").filter({ hasText: "'big.tsv' is larger than the 50 MB limit." })).toBeVisible();
    await page.getByLabel("Replace file for Cohort B", { exact: true }).first().setInputFiles(file("same.tsv"));
    await expect(page.getByRole("textbox", { name: "Label for Cohort B" })).toHaveValue("same_2");
    await page.getByRole("textbox", { name: "Label for Cohort B" }).fill("same");

    await page.getByRole("textbox", { name: "Category override (optional)" }).fill("biolink:Lipid");
    await page.getByRole("button", { name: "Start harmonization" }).click();
    await expect(page.getByTestId("submit-error")).toContainText("Cohort labels must be distinct (got same, same).");
    expect(submitted).toContain('"category":"biolink:Lipid"');
    expect(submitted).toContain('"keyColumn":"row_key"');
    expect(submitted).toContain('"vocabularies":{"HMDB":["HMDB_ID"]}');
  });

  test("many cohorts: the count rule and remap all; finished jobs: only finished ones can be chosen", async ({ page }) => {
    let manySpec = "";
    let fromJobs: unknown = null;
    await isolate(page, {
      "/api/harmonize/runs": [],
      "/api/harmonize/inspect": { columns: ["id", "name", "hmdb"], rowCount: 16 },
      "/api/harmonize/many": async (route: Route) => {
        manySpec = route.request().postDataBuffer()?.toString() ?? "";
        return route.fulfill({ status: 409, json: { detail: "This session already has 3 unfinished harmonize job(s) (limit 3); jobs run one at a time. Wait for one to finish, or cancel_job it." } });
      },
      "/api/jobs": [
        { jobId: "job-a", displayName: "Panel A", status: "complete", total: 5, completed: 5, errorCount: 0, env: "production", createdAt: 1, updatedAt: 1 },
        { jobId: "job-b", displayName: "Panel B", status: "complete", total: 5, completed: 5, errorCount: 0, env: "production", createdAt: 1, updatedAt: 1 },
        { jobId: "job-c", displayName: "Panel C", status: "processing", total: 5, completed: 2, errorCount: 0, env: "production", createdAt: 1, updatedAt: 1 },
      ],
      "/api/jobs/job-a": { jobId: "job-a", status: "complete", config: { entity_type: "biolink:SmallMolecule" } },
      "/api/jobs/job-b": { jobId: "job-b", status: "complete", config: { entityType: "biolink:Protein" } },
      "/api/harmonize/from-jobs": async (route: Route) => {
        fromJobs = route.request().postDataJSON();
        return route.fulfill({ status: 400, json: { detail: "The two jobs map different entity types (biolink:SmallMolecule and biolink:Protein). Choose two jobs of the same entity type." } });
      },
    });
    await goto(page, "/harmonize");
    await page.getByRole("radio", { name: /Many cohort files/ }).click();
    const tsv = (name: string) => ({ name, mimeType: "text/tab-separated-values", buffer: Buffer.from("id\tname\thmdb\n1\tGlucose\tHMDB0000122\n") });
    await page.getByLabel("Add cohort files", { exact: true }).first().setInputFiles([tsv("c1.tsv")]);
    await page.getByRole("button", { name: "Start harmonization" }).click();
    await expect(page.getByTestId("submit-error")).toContainText("A many-cohort run takes 2 to 12 cohort files (got 1).");
    await page.getByLabel("Add cohort files", { exact: true }).first().setInputFiles([tsv("c2.tsv"), tsv("c3.tsv")]);
    await expect(page.getByTestId("cohort-editor")).toHaveCount(3);
    await page.getByRole("checkbox", { name: "Remap all rows" }).click();
    await page.getByRole("button", { name: "Start harmonization" }).click();
    await expect(page.getByTestId("submit-error")).toContainText("This session already has 3 unfinished harmonize job(s) (limit 3)");
    expect(manySpec).toContain('"remapAll":true');
    expect(manySpec).toContain('"label":"c3"');

    await page.getByRole("radio", { name: /Two finished mapping jobs/ }).click();
    await page.getByRole("combobox", { name: "Mapping job for Job A" }).click();
    await expect(page.getByRole("option", { name: /Panel C/ })).toHaveAttribute("aria-disabled", "true");
    await page.getByRole("option", { name: /Panel A/ }).click();
    await expect(page.getByTestId("fj-a-entity")).toHaveText("Entity type: biolink:SmallMolecule");
    await page.getByRole("combobox", { name: "Mapping job for Job B" }).click();
    await page.getByRole("option", { name: /Panel B/ }).click();
    await expect(page.getByTestId("fj-b-entity")).toHaveText("Entity type: biolink:Protein");
    await expect(page.getByRole("switch", { name: "Link by name" })).not.toBeChecked();
    await page.getByRole("switch", { name: "Link by name" }).click();
    await page.getByRole("button", { name: "Harmonize these jobs" }).click();
    await expect(page.getByTestId("submit-error")).toContainText("The two jobs map different entity types (biolink:SmallMolecule and biolink:Protein).");
    expect(fromJobs).toEqual({ jobA: "job-a", jobB: "job-b", aLabel: "Panel_A", bLabel: "Panel_B", linkByName: true });
  });

  test("a header with a blank and a repeated column name: the screen stays up and says which columns cannot be chosen", async ({ page }) => {
    let submitted = "";
    await isolate(page, {
      "/api/harmonize/runs": [],
      "/api/harmonize/inspect": { columns: ["", "name", "id", "id"], rowCount: 3 },
      "/api/harmonize/cohorts": async (route: Route) => {
        submitted = route.request().postDataBuffer()?.toString() ?? "";
        return route.fulfill({ status: 400, json: { detail: "stop here" } });
      },
    });
    await goto(page, "/harmonize");
    const csv = (name: string) => ({ name, mimeType: "text/csv", buffer: Buffer.from(",name,id,id\n0,Glucose,1,2\n") });
    await page.getByLabel("Choose file for Cohort A", { exact: true }).first().setInputFiles(csv("a.csv"));
    await expect(page.getByRole("heading", { name: "Harmonize cohorts", level: 1 })).toBeVisible();
    const summary = page.getByTestId("inspect-summary").first();
    await expect(summary).toContainText("3 rows, 4 columns: (unnamed column 1), name, id (column 3), id");
    await expect(page.getByTestId("header-problems").first()).toContainText("Column 1 has no name");
    await expect(page.getByTestId("header-problems").first()).toContainText("'id' names 2 columns");
    await expect(page.getByRole("combobox", { name: "Name column for Cohort A" })).toHaveText("name");
    await page.getByRole("combobox", { name: "Key column for Cohort A" }).click();
    await expect(page.getByRole("option")).toHaveText([
      "No key column",
      "name",
      "id",
      "(unnamed column 1): has no name",
      "id (column 3): repeated name, not read",
    ]);
    await expect(page.getByRole("option", { name: "(unnamed column 1): has no name" })).toHaveAttribute("aria-disabled", "true");
    await page.getByRole("option", { name: "id", exact: true }).click();
    await page.getByLabel("Choose file for Cohort B", { exact: true }).first().setInputFiles(csv("b.csv"));
    await expect(page.getByTestId("inspect-summary").nth(1)).toBeVisible();
    await page.getByRole("button", { name: "Start harmonization" }).click();
    await expect(page.getByTestId("submit-error")).toContainText("stop here");
    expect(submitted).toContain('"nameColumn":"name"');
    expect(submitted).toContain('"keyColumn":"id"');
    expect(submitted).not.toContain('"nameColumn":""');
  });

  test("a failed poll keeps the run on screen with a could-not-refresh note", async ({ page }) => {
    test.setTimeout(60_000);
    const { stubs } = runStubs([{ state: "running", progress: progress("names_only", 5, 30), stage: "mapping" }]);
    let gets = 0;
    await isolate(page, {
      ...stubs,
      [`/api/harmonize/runs/${JOB}`]: async (route: Route, url: URL) => {
        gets += 1;
        if (gets === 1) return (stubs[`/api/harmonize/runs/${JOB}`] as (r: Route, u: URL) => Promise<void>)(route, url);
        return route.fulfill({ status: 502, contentType: "text/html", body: "<html><body><h1>502 Bad Gateway</h1></body></html>" });
      },
    });
    await goto(page, `/harmonize/runs/${JOB}/run`);
    await expect(page.getByRole("progressbar", { name: "Names-only arm progress" })).toBeVisible();
    await expect(page.getByTestId("refresh-failed")).toContainText("Could not refresh the run", { timeout: 20_000 });
    await expect(page.getByRole("progressbar", { name: "Names-only arm progress" })).toBeVisible();
    await expect(page.getByText("The run did not load")).toHaveCount(0);
  });

  test("a run the job runner lost opens from its list entry as unknown, with no retries and later steps locked", async ({ page }) => {
    let gets = 0;
    await isolate(page, {
      "/api/harmonize/runs": [{ ...RUN_BASE, state: "unknown", reason: "The job runner has no record of this job; it may have been deleted." }],
      [`/api/harmonize/runs/${JOB}`]: async (route: Route) => {
        gets += 1;
        return route.fulfill({ status: 400, json: { detail: "Unknown job id." } });
      },
    });
    await goto(page, "/harmonize");
    await page.getByRole("link", { name: /^Open unknown run: example_cohort_a, example_cohort_b/ }).click();
    await expect(page).toHaveURL(new RegExp(`/harmonize/runs/${JOB}/run$`));
    await expect(page.getByTestId("run-state").first()).toHaveText("Unknown");
    await expect(page.getByTestId("run-reason")).toContainText("The job runner has no record of this job");
    await expect(await stepState(page, "Review and flag")).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await page.waitForTimeout(1500);
    expect(gets).toBe(1);
    await goto(page, `/harmonize/runs/${JOB}/review`);
    await expect(page.getByText("Review and flag is not available for this run")).toBeVisible();
  });

  test("de-flagging the only row on the last page steps back to a page with rows", async ({ page }) => {
    const { stubs, items } = runStubs([{ state: "complete", progress: null, stage: "done" }]);
    items.splice(0, items.length);
    for (let n = 1; n <= 101; n += 1) {
      const k = String(n).padStart(3, "0");
      items.push({
        ref: `link:names_only:${n}`,
        kind: "link",
        arm: "names_only",
        members: [
          { cohort: "example_cohort_a", key: `a${k}`, name: `name a${k}`, chosenKgId: "RM:1" },
          { cohort: "example_cohort_b", key: `b${k}`, name: `name b${k}`, chosenKgId: "RM:1" },
        ],
        detail: { basis: "node", ambiguous: true, oneToOne: false, origin: "links" },
        suggested: true,
        flagged: true,
        source: "biomapper",
      });
    }
    await isolate(page, stubs);
    await goto(page, `/harmonize/runs/${JOB}/review?view=flags`);
    await page.getByRole("combobox", { name: "Flag state" }).click();
    await page.getByRole("option", { name: "Flagged", exact: true }).click();
    await expect(page.getByTestId("item-totals")).toContainText("101 items match these filters");
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page.getByText("Showing 101 to 101 of 101 items")).toBeVisible();
    await page.getByRole("checkbox", { name: /^Flagged: Link, example_cohort_a a101/ }).click();
    await expect(page.getByTestId("item-totals")).toContainText("100 items match these filters");
    await expect(page.getByText("Showing 1 to 100 of 100 items")).toBeVisible();
    await expect(page.getByText("No items match these filters")).toHaveCount(0);
  });

  test("bulk flag or clear with every choice on its widest setting asks first", async ({ page }) => {
    const { stubs } = runStubs([{ state: "complete", progress: null, stage: "done" }]);
    let bulkCalls = 0;
    await isolate(page, {
      ...stubs,
      [`/api/harmonize/runs/${JOB}/flags/bulk`]: async (route: Route, url: URL) => {
        bulkCalls += 1;
        return (stubs[`/api/harmonize/runs/${JOB}/flags/bulk`] as (r: Route, u: URL) => Promise<void>)(route, url);
      },
    });
    await goto(page, `/harmonize/runs/${JOB}/review?view=flags`);
    await expect(page.getByTestId("item-totals")).toContainText("2 flagged in this run");
    await page.getByRole("button", { name: "Clear flags on matching items" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("Clear every flag in this run?");
    await dialog.getByRole("button", { name: "Keep flags as they are" }).click();
    expect(bulkCalls).toBe(0);
    await page.getByRole("button", { name: "Clear flags on matching items" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Clear every flag" }).click();
    await expect(page.getByTestId("item-totals")).toContainText("0 flagged in this run");
    expect(bulkCalls).toBe(1);
  });
});
