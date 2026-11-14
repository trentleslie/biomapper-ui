import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { goto, isolate, JOBS } from "./helpers";

// Every container whose content can overflow must show a scroll bar the reader can see without hovering or
// scrolling first. docs/harmonization/scroll-audit.md lists each site; these tests fill them past their bounds
// (stubbed rows, short viewports) and check the rule below on whatever overflows.

type Violation = { where: string; axis: "x" | "y"; why: string };

/**
 * In the page: every element whose content exceeds its box on an axis must (1) scroll on that axis
 * (overflow auto or scroll, not hidden or clip), (2) carry `scroll-visible` or be a ScrollArea viewport that has
 * a scrollbar element, and (3) actually reserve room for the bar (offset size minus client size minus borders > 0),
 * which is how an always-drawn classic bar shows up and an overlay or hidden one does not.
 * Text truncated with an ellipsis, and the rail's sideways clip (marked data-clip-x="intended"), are intentional
 * clipping, not a missing bar, and are skipped.
 * The document itself must not scroll: the shell's main region is the page's scroller.
 */
async function audit(page: Page): Promise<{ violations: Violation[]; overflowing: string[] }> {
  return page.evaluate(() => {
    const describe = (el: Element) => {
      const id = el.getAttribute("data-testid");
      const cls = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean).slice(0, 4).join(".");
      return `${el.tagName.toLowerCase()}${id ? `[data-testid=${id}]` : ""}${cls ? `.${cls}` : ""}`;
    };
    const violations: { where: string; axis: "x" | "y"; why: string }[] = [];
    const overflowing: string[] = [];

    const doc = document.scrollingElement as HTMLElement;
    if (doc.scrollHeight > doc.clientHeight + 1) violations.push({ where: "document", axis: "y", why: "the document scrolls instead of the shell's main region" });
    if (doc.scrollWidth > doc.clientWidth + 1) violations.push({ where: "document", axis: "x", why: "the document scrolls horizontally" });

    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.display === "contents") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) continue; // sr-only and collapsed boxes
      const isViewport = el.hasAttribute("data-radix-scroll-area-viewport");
      const bar = isViewport && el.parentElement?.querySelector("[data-orientation]") != null;
      const borderX = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
      const borderY = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
      for (const axis of ["y", "x"] as const) {
        const over = axis === "y" ? el.scrollHeight > el.clientHeight + 1 : el.scrollWidth > el.clientWidth + 1;
        if (!over) continue;
        const overflow = axis === "y" ? cs.overflowY : cs.overflowX;
        if (overflow === "visible") continue; // not a clipping box
        if (axis === "x" && cs.textOverflow === "ellipsis") continue;
        const where = describe(el);
        overflowing.push(`${where} (${axis})`);
        if (overflow === "hidden" && axis === "x" && el.getAttribute("data-clip-x") === "intended") continue;
        if (overflow !== "auto" && overflow !== "scroll") {
          violations.push({ where, axis, why: `content exceeds the box but overflow-${axis} is ${overflow}` });
          continue;
        }
        if (!el.classList.contains("scroll-visible") && !bar) {
          violations.push({ where, axis, why: "scrolls but has neither scroll-visible nor a ScrollArea scrollbar" });
          continue;
        }
        if (!bar) {
          const reserved = axis === "y" ? el.offsetWidth - el.clientWidth - borderX : el.offsetHeight - el.clientHeight - borderY;
          if (reserved <= 0) violations.push({ where, axis, why: "no scrollbar is drawn (no room reserved for it)" });
        }
      }
    }
    return { violations, overflowing };
  });
}

async function expectNoViolations(page: Page, mustOverflow: string[] = []) {
  const { violations, overflowing } = await audit(page);
  expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  // Guard against a vacuous pass: the sites a test claims to fill really did overflow.
  for (const needle of mustOverflow) {
    expect(overflowing.some((o) => o.includes(needle)), `${needle} never overflowed; saw ${JSON.stringify(overflowing)}`).toBe(true);
  }
}

const tier = (i: number) => (["high", "medium", "low"] as const)[i % 3];

/** A finished job: `n` rows, each carrying many vocabulary identifiers so the results table is wide. */
function jobResult(jobId: string, n: number) {
  const vocabs = ["hmdb", "chebi", "pubchem.compound", "kegg.compound", "lipidmaps", "refmet", "cas", "inchikey", "metacyc", "drugbank", "swisslipids", "lmsd"];
  const results = Array.from({ length: n }, (_, i) => ({
    name: `compound number ${i} with a fairly long descriptive name`,
    resolved: true,
    primaryCurie: `HMDB:HMDB${String(i).padStart(7, "0")}`,
    confidenceScore: 0.9 - (i % 10) / 20,
    confidenceTier: tier(i),
    needsReview: i % 2 === 0,
    reviewReason: i % 2 === 0 ? "low_score" : null,
    identifiers: Object.fromEntries(vocabs.map((v) => [v, [`${v}:${i}00001`, `${v}:${i}00002`]])),
    kgEquivalentIds: {},
    providedIds: {},
  }));
  return { job_id: jobId, status: "complete", completed: n, total: n, error_count: 0, results };
}

function dashboardStubs(jobId: string, n = 300) {
  const body = jobResult(jobId, n);
  return {
    [`/api/map/stream/${jobId}`]: (route: import("@playwright/test").Route) =>
      route.fulfill({ status: 200, contentType: "text/event-stream", body: `event: progress\ndata: ${JSON.stringify(body)}\n\n` }),
    [`/api/map/result/${jobId}`]: body,
  };
}

test.describe("scroll bars on the demo surface @demo", () => {
  test("results table, review list and vocabulary coverage on a long demo job", async ({ page }) => {
    const jobId = "demo-job-1";
    await isolate(page, dashboardStubs(jobId));
    await goto(page, `/job/${jobId}?demo=true`);
    await expect(page.getByTestId("input-results-search")).toBeVisible();
    await expectNoViolations(page, ["main"]);
    // The wide table scrolls sideways inside its own box, with a bar.
    const wide = await page.evaluate(() => {
      // The results table is the widest one on the page.
      const wrappers = Array.from(document.querySelectorAll("table")).map((t) => t.parentElement as HTMLElement);
      return wrappers.some((w) => w.scrollWidth > w.clientWidth + 1);
    });
    expect(wide, "results table never overflowed horizontally").toBe(true);
  });

  test("results confidence dropdown", async ({ page }) => {
    const jobId = "demo-job-2";
    await isolate(page, dashboardStubs(jobId, 40));
    await page.setViewportSize({ width: 1440, height: 260 });
    await goto(page, `/job/${jobId}?demo=true`);
    await page.getByTestId("select-results-confidence").click();
    await expect(page.getByRole("option", { name: "All Results" })).toBeVisible();
    await expectNoViolations(page);
  });

  test("rail: the expanded panel on a short window", async ({ page }) => {
    await isolate(page);
    await page.setViewportSize({ width: 1440, height: 120 });
    await goto(page, "/demo");
    await page.getByTestId("app-nav").hover();
    await expect(page.getByTestId("app-nav")).toHaveAttribute("data-expanded", "true");
    await expect(page.getByTestId("app-nav-panel")).toHaveCSS("width", "240px"); // past the width transition
    await expectNoViolations(page, ["app-nav-panel"]);
  });
});

test.describe("scroll bars on the signed-in surface @app", () => {
  test("upload: entity-type dropdown, vocabulary list and name-column dropdown", async ({ page }) => {
    const entityTypes = Array.from({ length: 90 }, (_, i) => ({ type: `biolink:EntityType${i}`, defaultPrefixes: ["HMDB"] }));
    const vocabularies = Array.from({ length: 120 }, (_, i) => ({ prefix: `VOCAB${i}` }));
    await isolate(page, {
      "/api/discovery/entity-types": entityTypes,
      "/api/discovery/vocabularies": vocabularies,
    });
    await goto(page, "/");
    const columns = Array.from({ length: 60 }, (_, i) => `column_${i}`);
    const csv = `${columns.join(",")}\n${columns.map((_, i) => `value ${i}`).join(",")}\n`;
    await page.locator("input[type=file]").setInputFiles({ name: "wide.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
    await expect(page.getByTestId("select-name-col")).toBeVisible();

    await page.getByTestId("select-name-col").click();
    await expect(page.getByRole("option", { name: "column_0" })).toBeVisible();
    await expectNoViolations(page, ["select"]);
    await page.keyboard.press("Escape");

    await page.getByTestId("select-entity-type").click();
    await expect(page.getByRole("option").first()).toBeVisible();
    await expectNoViolations(page, ["select"]);
    await page.keyboard.press("Escape");

    await page.getByTestId("btn-toggle-all-vocabs").click();
    await expect(page.getByTestId("vocab-checkboxes")).toBeVisible();
    await expectNoViolations(page, ["vocab-checkboxes"]);
  });

  test("feedback dialog on a short window", async ({ page }) => {
    await isolate(page);
    await page.setViewportSize({ width: 1440, height: 300 });
    await goto(page, "/");
    await page.getByRole("button", { name: "Submit feedback" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expectNoViolations(page, ["z-50"]);
  });

  test("jobs list and its delete dialog", async ({ page }) => {
    const jobs = Array.from({ length: 150 }, (_, i) => ({ ...JOBS[0], jobId: `cccccccc-0000-0000-0000-${String(i).padStart(12, "0")}`, displayName: `Job ${i}` }));
    await isolate(page, { "/api/jobs": jobs });
    await goto(page, "/jobs");
    await expect(page.getByRole("table").getByText("Job 0", { exact: true })).toBeVisible();
    await expectNoViolations(page, ["main"]);
    await page.getByTitle("Delete job").first().click();
    await page.setViewportSize({ width: 1440, height: 160 });
    await expect(page.getByRole("alertdialog")).toHaveCSS("max-height", "128px");
    await expectNoViolations(page, ["z-50"]);
  });

  test("flagged annotations list", async ({ page }) => {
    const flags = Array.from({ length: 200 }, (_, i) => ({ name: `flagged compound ${i}`, count: i + 1 }));
    await isolate(page, { "/api/flags/all": { items: flags, total: flags.length } });
    await goto(page, "/flagged");
    await expect(page.getByText("flagged compound 0", { exact: true })).toBeVisible();
    await expectNoViolations(page, ["main"]);
  });

  test("harmonize: runs list, items list, result tables and cohort column list", async ({ page }) => {
    const report = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, "../../python-api/data/harmonize_examples/many_cohort/recording/report.json"), "utf8"),
    );
    const runBase = { kind: "harmonize_many", labels: ["a", "b", "c"], entity: "metabolites", createdAt: "2026-11-14T00:00:00Z" };
    const runs = Array.from({ length: 40 }, (_, i) => ({ ...runBase, jobId: `run${i}`, state: "complete" }));
    const items = Array.from({ length: 150 }, (_, i) => ({
      ref: `group:names_only:${i}`, kind: "group", arm: "names_only", suggested: false, flagged: false, source: "biomapper",
      members: Array.from({ length: 3 }, (_, m) => ({ cohort: `cohort_${m}`, key: `k${i}_${m}`, name: `a long analyte name number ${i} ${m}`, chosenKgId: "RM:0000001" })),
      detail: { node: "RM:0000001", clean: true, multiplicity: false, broad: false, origin: "groups" },
    }));
    await isolate(page, {
      "/api/harmonize/runs": runs,
      "/api/harmonize/runs/run0": runs[0],
      "/api/harmonize/runs/run0/report": report,
      "/api/harmonize/runs/run0/items": async (route, url) => {
        const limit = Number(url.searchParams.get("limit") ?? 100);
        return route.fulfill({ json: { total: items.length, flaggedTotal: 0, items: items.slice(0, limit) } });
      },
      "/api/harmonize/inspect": { columns: Array.from({ length: 40 }, (_, i) => `column_${i}`), rowCount: 10 },
    });
    await page.setViewportSize({ width: 1100, height: 700 });
    await goto(page, "/harmonize");
    await expect(page.getByTestId("runs-list")).toContainText("a, b, c");
    await page.getByLabel("Choose file for Cohort A", { exact: true }).first().setInputFiles({ name: "wide.tsv", mimeType: "text/tab-separated-values", buffer: Buffer.from("x\n") });
    await expect(page.getByTestId("vocab-columns").first()).toBeVisible();
    await expectNoViolations(page, ["main", "ul.scroll-visible.max-h-", "vocab-columns"]);

    await goto(page, "/harmonize/runs/run0/review?view=flags");
    await expect(page.getByTestId("items-table")).toBeVisible();
    await expectNoViolations(page, ["items-table"]);

    await goto(page, "/harmonize/runs/run0/review?view=results");
    await expect(page.getByTestId("groups-table")).toBeVisible();
    await expectNoViolations(page, ["groups-table"]);
  });

  test("benchmark runs table, run results tables and filter dropdowns", async ({ page }) => {
    const metric = (vocabulary: string) => ({
      vocabulary, n: 100, map: 0.8, mrr: 0.8, hitAt1: 0.7, hitAt5: 0.9, hitAtInf: 0.95, meanRecallAt5: 0.8, meanRecallAtInf: 0.9,
      meanCandidates: 3, normalizationLift: 0.1, runErrorCount: 0, orderAsserted: true, decisionLabel: "SHIP",
      diagnostics: { rankingGap: 1, rerankingHeadroom: 1, recallHeadroom: 1 },
    });
    const run = (id: string) => ({
      run_id: id, dataset_name: "gold", status: "complete", sdk_version: "1.9.0", env: "production", order_asserted: true, total: 100,
      corpus_metrics: Array.from({ length: 40 }, (_, i) => metric(`vocab${i}`)), created_at: 1_700_000_000, updated_at: 1_700_000_100,
    });
    const runs = Array.from({ length: 80 }, (_, i) => run(`run-${i}`));
    const rows = Array.from({ length: 300 }, (_, i) => ({
      name: `row ${i}`, vocabulary: "vocab1", ground_truth: "HMDB:HMDB0000001;HMDB:HMDB0000002;HMDB:HMDB0000003",
      returned_ids: "CHEBI:1;CHEBI:2;CHEBI:3", hit_ranks: "1", category: "EXACT_MATCH",
    }));
    await isolate(page, {
      "/api/benchmark/runs": runs,
      "/api/benchmark/runs/run-0": run("run-0"),
      "/api/benchmark/runs/run-0/rows": rows,
    });
    await goto(page, "/benchmark/runs");
    await expect(page.getByRole("heading", { name: "Benchmark runs" })).toBeVisible();
    await expectNoViolations(page, ["main"]);

    await goto(page, "/benchmark/runs/run-0");
    await expect(page.getByText("Per-row disagreement log")).toBeVisible();
    await expectNoViolations(page, ["main"]);
    await page.setViewportSize({ width: 1440, height: 400 });
    await page.getByRole("combobox").nth(1).click();
    await expect(page.getByRole("option", { name: "vocab0" })).toBeVisible();
    await expectNoViolations(page, ["select"]);
  });
});
