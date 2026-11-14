import { test, expect, type Page } from "@playwright/test";
import { goto, isolate } from "./helpers";
import { harmonizeStubs, manyRun, resultsRun, twoRun } from "./harmonize-stubs";

// The one-page harmonization screen against stubbed /api responses (see harmonize-stubs.ts): setup at the top, the
// run and every result below. Runs on the signed-in surface (the dev-only auth bypass).

const FILES = {
  "north.csv": { columns: ["Panel Row", "Analyte (reported)", "HMDB Accession", "KEGG cpd"], rowCount: 6 },
  "south.tsv": { columns: ["sample_key", "Metabolite Label", "hmdb_code"], rowCount: 6 },
  "east.tsv": { columns: ["ID", "Compound", "HMDB"], rowCount: 6 },
};
const file = (name: string) => ({ name, mimeType: "text/plain", buffer: Buffer.from("x\n") });

async function pick(page: Page, names: string[]) {
  await page.getByTestId("cohort-file-input").setInputFiles(names.map(file));
}

test.describe("harmonize screen @app", () => {
  // With Clerk's script aborted, the dev server raises its "failed to load Clerk JS" overlay a few seconds after
  // load. It is an artifact of the offline test setup, not of the page; remove it whenever it appears so the
  // longer walks below are not blocked by it.
  test.beforeEach(async ({ page }) => {
    await page.addLocatorHandler(page.locator("vite-error-overlay"), async () => {
      await page.evaluate(() => document.querySelectorAll("vite-error-overlay").forEach((el) => el.remove()));
    });
  });

  test("two cohorts: setup, refusal as written, progress, results, flags and the EITL file", async ({ page }) => {
    const run = twoRun();
    const { stubs } = harmonizeStubs({
      runs: [run],
      files: FILES,
      submit: (_kind, body) => {
        const spec = JSON.parse(/name="spec"\r\n\r\n([^\r]*)/.exec(body)![1]);
        if (spec.a.label === spec.b.label) return { detail: `Cohort labels must be distinct (got ${spec.a.label}, ${spec.b.label}).` };
        expect(spec.entity).toBe("biolink:SmallMolecule");
        expect(spec.a).toEqual({ label: "north", nameColumn: "Analyte (reported)", vocabularies: { HMDB: ["HMDB Accession"], KEGG: ["KEGG cpd"] } });
        expect(spec.b).toEqual({ label: "south", nameColumn: "Metabolite Label", keyColumn: "sample_key", vocabularies: { HMDB: ["hmdb_code"] } });
        return { run };
      },
    });
    await isolate(page, stubs);
    await goto(page, "/harmonize");

    // The rail entry sits next to entity resolution.
    const rail = page.getByRole("navigation", { name: "Main" }).getByRole("link");
    await expect(rail.nth(0)).toHaveAccessibleName("New job");
    await expect(rail.nth(1)).toHaveAccessibleName("Harmonize");
    await expect(page.getByRole("heading", { name: "Harmonize cohorts" })).toBeVisible();
    await expect(page.getByText("No runs yet")).toBeVisible();

    await pick(page, ["north.csv", "south.tsv"]);
    const cards = page.getByTestId("cohort-card");
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0).getByTestId("cohort-file-facts")).toContainText("6 rows, 4 columns");
    await expect(cards.nth(0).getByTestId("cohort-columns")).toContainText("KEGG cpd");
    // Column pickers offer exactly the file's own header.
    await page.getByLabel("Name column for Cohort B").click();
    await expect(page.getByRole("option")).toHaveText(["sample_key", "Metabolite Label", "hmdb_code"]);
    await page.keyboard.press("Escape");

    // Equal labels: the API's refusal is shown as written.
    await page.getByLabel("Cohort label for Cohort B").fill("north");
    await page.getByTestId("btn-start-run").click();
    await expect(page.getByTestId("submit-error")).toContainText("Cohort labels must be distinct (got north, north).");
    await page.getByLabel("Cohort label for Cohort B").fill("south");
    await page.getByTestId("btn-start-run").click();

    // Progress: the current arm's done out of total, the cohort being mapped, never over 100 percent.
    const progress = page.getByTestId("run-progress");
    await expect(progress).toContainText("Names only arm: 10 of 30 entities", { timeout: 15_000 });
    await expect(progress).toContainText("Mapping cohort example_cohort_a now.");
    await expect(progress).toContainText("Identifier arm: 53 of 53 entities", { timeout: 15_000 });
    await expect(progress).toContainText("100%");
    await expect(page.getByText("107")).toHaveCount(0);
    await expect(page.getByTestId("runs-list")).toContainText("example_cohort_a, example_cohort_b");

    // Results.
    await expect(page.getByTestId("run-panel").getByTestId("run-state")).toHaveText("complete", { timeout: 15_000 });
    await expect(page.getByTestId("arm-names_only")).toContainText("29 links");
    await expect(page.getByTestId("arm-identifier")).toContainText("Ambiguous links");
    await expect(page.getByTestId("diff-set-both")).toContainText("Glucose (a01) with D-Glucose (b01)");
    await expect(page.getByTestId("name-linking")).toContainText("Name links are on because the category is biolink:SmallMolecule");
    await expect(page.getByTestId("excluded")).toContainText("No rows were excluded from any cohort.");
    await expect(page.getByTestId("warnings")).toContainText("KEGG is declared only for 'example_cohort_a'");
    await expect(page.getByTestId("version-pins")).toContainText("1.9.0");

    // Flags: biomapper's suggestion applied (4 ambiguous links and 1 review entry), then one change each way.
    const flagged = page.getByTestId("items-flagged-total");
    await expect(flagged).toHaveText("5");
    await expect(page.getByTestId("items-total")).toHaveText("60");
    const glucose = page.getByTestId("item-row").filter({ hasText: "D-Glucose" }).first();
    await glucose.getByTestId("btn-item-flag").click();
    await expect(flagged).toHaveText("6");
    await expect(glucose.getByTestId("item-source")).toContainText("organizer (you)");
    const creatinine = page.getByTestId("item-row").filter({ hasText: "a13" }).first();
    await expect(creatinine.getByTestId("btn-item-flag")).toHaveAttribute("aria-pressed", "true");
    await creatinine.getByTestId("btn-item-flag").click();
    await expect(flagged).toHaveText("5");
    await expect(creatinine.getByTestId("item-source")).toContainText("organizer (you)");

    // Filter the list, then flag in bulk by a filter and see how many matched.
    await page.getByLabel("Show kind").click();
    await page.getByRole("option", { name: "Review entries" }).click();
    await expect(page.getByTestId("items-total")).toHaveText("1");
    await expect(page.getByTestId("item-row")).toContainText("One-sided identifier check");
    await page.getByLabel("Bulk ambiguous").click();
    await page.getByRole("option", { name: "Ambiguous", exact: true }).click();
    await page.getByTestId("btn-bulk-deflag").click();
    await expect(page.getByTestId("flag-message")).toContainText("4 items matched and were de-flagged.");
    await expect(flagged).toHaveText("2");

    // Reset everything to biomapper's suggestion.
    await page.getByTestId("btn-reset-all").click();
    await page.getByRole("button", { name: "Reset all flags" }).last().click();
    await expect(flagged).toHaveText("5");

    // Review evidence: a row item and a link item open with their detail.
    await page.getByRole("button", { name: "Open review item Co" }).click();
    await expect(page.getByTestId("review-detail")).toContainText("contradicted");
    await expect(page.getByTestId("review-detail")).toContainText("not_captured: the engine sent no candidates");

    // Exports: JSON is the default for EITL, and the skipped count comes from the response header.
    await expect(page.getByLabel("JSON (recommended)")).toBeChecked();
    await expect(page.getByTestId("btn-send-eitl")).toBeDisabled();
    await expect(page.getByTestId("eitl-preview")).toContainText("4 pairs in the file now. 1 flagged item was left out");
    const download = page.waitForEvent("download");
    await page.getByTestId("btn-export-eitl").click();
    expect((await download).suggestedFilename()).toBe("harmonize_cohorts_example_cohort_a_example_cohort_b_eitl_pairs.json");
    await expect(page.getByTestId("export-result")).toContainText("1 flagged item was left out");
    const links = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download Links as TSV" }).click();
    expect((await links).suggestedFilename()).toBe("harmonize_cohorts_example_cohort_a_example_cohort_b_links.tsv");
  });

  test("many cohorts from the example, groups and status, and a run found again after leaving", async ({ page }) => {
    const run = manyRun();
    const { stubs } = harmonizeStubs({ runs: [run], submit: (kind) => (kind === "example" ? { run } : { detail: "unexpected" }) });
    await isolate(page, stubs);
    await goto(page, "/harmonize");
    await page.getByTestId("btn-example-many").click();
    await expect(page).toHaveURL(/\/harmonize\/run-many$/);
    await expect(page.getByTestId("run-title")).toContainText("example_cohort_a · example_cohort_b");
    await expect(page.getByTestId("status-grade")).toContainText("Status: ok. Grade: iteration-grade, not for publication.");
    await expect(page.getByTestId("arm-identifier")).toContainText("Groups with multiplicity");
    await expect(page.getByTestId("diff-set-membership_changed")).toContainText("RM:0028430");
    // A group with more than one row from one cohort.
    await page.getByLabel("Show kind").click();
    await page.getByRole("option", { name: "Groups", exact: true }).click();
    await expect(page.getByTestId("item-row").filter({ hasText: "multiplicity" }).first()).toBeVisible();

    // Leave for another page and come back through the rail: the run is open again and listed.
    await page.getByRole("link", { name: "New job" }).click();
    await page.getByRole("link", { name: "Harmonize" }).click();
    await expect(page).toHaveURL(/\/harmonize\/run-many$/);
    await expect(page.getByTestId("runs-list").getByTestId("run-state")).toHaveText("complete");
  });

  test("many cohorts: the file count rule, then a run from uploaded files with remap all", async ({ page }) => {
    const run = manyRun("run-many-upload");
    let spec: Record<string, unknown> | null = null;
    const { stubs } = harmonizeStubs({
      runs: [run],
      files: FILES,
      submit: (_k, body) => {
        spec = JSON.parse(/name="spec"\r\n\r\n([^\r]*)/.exec(body)![1]);
        return { run };
      },
    });
    await isolate(page, stubs);
    await goto(page, "/harmonize");
    await page.getByRole("tab", { name: "Many cohorts" }).click();
    await pick(page, ["north.csv"]);
    await expect(page.getByTestId("many-count-message")).toHaveText("A many-cohort run takes 2 to 12 cohort files (got 1).");
    await expect(page.getByTestId("btn-start-run")).toBeDisabled();
    await pick(page, ["south.tsv", "east.tsv"]);
    await expect(page.getByTestId("cohort-card")).toHaveCount(3);
    await page.getByLabel("Remap all rows").check();
    await page.getByTestId("btn-start-run").click();
    await expect(page).toHaveURL(/run-many-upload$/);
    expect(spec).toMatchObject({ remapAll: true, cohorts: [{ label: "north" }, { label: "south" }, { label: "east", keyColumn: "ID" }] });
  });

  test("cancel and resume a running run", async ({ page }) => {
    const run = twoRun("run-cancel");
    run.states = [{ state: "running", progress: { function: "f", arm: "names_only", cohort: "example_cohort_a", cohorts: [], entitiesDone: 5, entitiesTotal: 30 } }];
    const { stubs } = harmonizeStubs({ runs: [run], listed: [run] });
    await isolate(page, stubs);
    await goto(page, "/harmonize/run-cancel");
    await page.getByTestId("btn-cancel-run").click();
    await expect(page.getByTestId("run-panel").getByTestId("run-state")).toHaveText("cancelled");
    await page.getByTestId("btn-resume-run").click();
    await expect(page.getByTestId("run-panel").getByTestId("run-state")).toHaveText("running");
  });

  test("finished jobs: only finished jobs, link by name, a complete run with one arm; refusals as written", async ({ page }) => {
    const run = resultsRun();
    let calls = 0;
    const { stubs } = harmonizeStubs({
      runs: [run],
      submit: (_k, body) => {
        calls += 1;
        if (calls === 1) return { detail: "This job was mapped before harmonizing finished jobs was supported. Map the file again, then harmonize." };
        expect(JSON.parse(body)).toEqual({ jobA: "job-a", jobB: "job-b", aLabel: "Panel_A", bLabel: "Panel_B", linkByName: true });
        return { run };
      },
    });
    await isolate(page, stubs);
    await goto(page, "/harmonize");
    await page.getByRole("tab", { name: "Finished jobs" }).click();
    await page.getByLabel("Job A", { exact: true }).click();
    await expect(page.getByRole("option", { name: /Still mapping/ })).toBeDisabled();
    await page.getByRole("option", { name: /Panel A/ }).click();
    await page.getByLabel("Job B", { exact: true }).click();
    await page.getByRole("option", { name: /Panel B/ }).click();
    await expect(page.getByTestId("job-b-entity")).toContainText("biolink:SmallMolecule");
    await expect(page.getByTestId("switch-link-by-name")).toHaveAttribute("aria-checked", "false");
    await page.getByTestId("switch-link-by-name").click();
    await page.getByTestId("btn-start-from-jobs").click();
    await expect(page.getByTestId("submit-error")).toContainText(
      "This job was mapped before harmonizing finished jobs was supported. Map the file again, then harmonize.",
    );
    await page.getByTestId("btn-start-from-jobs").click();
    await expect(page.getByTestId("run-panel").getByTestId("run-state")).toHaveText("complete");
    await expect(page.getByTestId("btn-cancel-run")).toHaveCount(0);
    await expect(page.getByTestId("arm-identifier-skipped")).toContainText("Not part of this run");
    await expect(page.getByTestId("name-linking")).toContainText("Decided by you");
  });

  test("the queue limit and an unfinished report are shown in the page, not as an error page", async ({ page }) => {
    const run = twoRun("run-wait");
    run.states = [{ state: "queued" }];
    const { stubs } = harmonizeStubs({
      runs: [run],
      listed: [run],
      submit: () => ({
        status: 409,
        detail: "This session already has 3 unfinished harmonize job(s) (limit 3); jobs run one at a time. Wait for one to finish, or cancel_job it.",
      }),
    });
    await isolate(page, stubs);
    await goto(page, "/harmonize/run-wait");
    await expect(page.getByTestId("run-panel").getByTestId("run-state")).toHaveText("queued");
    await expect(page.getByTestId("run-progress")).toContainText("Waiting to start");
    await expect(page.getByText(/its report is available once it is complete/)).toHaveCount(0);
    await page.getByTestId("btn-example-two").click();
    await expect(page.getByTestId("example-error")).toContainText("This session already has 3 unfinished harmonize job(s) (limit 3)");
  });

  test("a run the package no longer knows is listed as unknown with its reason", async ({ page }) => {
    const { stubs } = harmonizeStubs({ runs: [] });
    stubs["/api/harmonize/runs"] = [
      { jobId: "gone", state: "unknown", reason: "No job gone in this home.", kind: "harmonize_cohorts", labels: ["a", "b"], entity: "metabolites", createdAt: "2026-11-14T06:42:30Z" },
    ];
    await isolate(page, stubs);
    await goto(page, "/harmonize");
    const row = page.getByTestId("run-row");
    await expect(row.getByTestId("run-state")).toHaveText("unknown");
    await expect(row.getByTestId("run-row-reason")).toHaveText("No job gone in this home.");
  });
});
