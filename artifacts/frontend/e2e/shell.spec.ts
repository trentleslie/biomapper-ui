import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { goto, isolate, JOBS } from "./helpers";

// Screenshots for the PR are written only on request (SHELL_SCREENSHOTS=1), so a normal run never edits the repo.
const SCREENSHOT_DIR = path.resolve(import.meta.dirname, "../../../docs/harmonization/screenshots");
const TAKE_SCREENSHOTS = process.env.SHELL_SCREENSHOTS === "1";

async function expectRailExpandsWithoutReflow(page: Page) {
  const shell = page.getByTestId("app-shell");
  const nav = page.getByTestId("app-nav");
  const main = page.locator("main");
  await expect(shell).toBeVisible();
  await expect(nav).toBeVisible();
  await expect(nav).toHaveAttribute("data-expanded", "false");

  const before = await main.boundingBox();
  await nav.hover();
  await expect(nav).toHaveAttribute("data-expanded", "true");
  const after = await main.boundingBox();
  expect(before).not.toBeNull();
  expect(after?.x).toBe(before?.x);
  expect(after?.width).toBe(before?.width);

  // Leaving the rail closes it again.
  await page.mouse.move(1200, 450);
  await expect(nav).toHaveAttribute("data-expanded", "false");
}

async function expectSelfHostedInter(page: Page, googleFontRequests: string[]) {
  const family = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  expect(family).toMatch(/^"?Inter\b/);
  // The face actually loads from the app's own origin, not just the declaration.
  // (document.fonts.check alone would pass on a machine with Inter installed, so look for a loaded @font-face.)
  const loadedFrom = await page.evaluate(async () => {
    await document.fonts.load("16px Inter");
    await document.fonts.ready;
    const faces = [...document.fonts].filter((f) => f.family.replace(/["']/g, "") === "Inter" && f.status === "loaded");
    const urls = performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n.endsWith(".woff2"));
    return { faces: faces.length, urls };
  });
  expect(loadedFrom.faces).toBeGreaterThan(0);
  expect(loadedFrom.urls.some((u) => new URL(u).pathname === "/fonts/inter-var-latin.woff2")).toBe(true);
  expect(googleFontRequests.filter((u) => /family=Inter\b/.test(u))).toEqual([]);
}

test.describe("demo shell @demo", () => {
  test("rail, destinations and self-hosted Inter on /demo", async ({ page }) => {
    const googleFontRequests = await isolate(page);
    await goto(page, "/demo");
    await expect(page.getByRole("heading", { name: "See BioMapper in Action" })).toBeVisible();

    await expectRailExpandsWithoutReflow(page);

    // Destinations that existed on the demo shell before the port.
    const signIn = page.getByRole("link", { name: "Sign In" });
    await expect(signIn).toHaveAttribute("href", "/login");
    await expect(page.getByRole("link", { name: "BioMapper demo home" })).toHaveAttribute("href", "/demo");
    await expect(page.getByText("Demo Mode")).toBeAttached();

    await expectSelfHostedInter(page, googleFontRequests);
  });

  test("keyboard focus opens the rail", async ({ page }) => {
    await isolate(page);
    await goto(page, "/demo");
    const nav = page.getByTestId("app-nav");
    await expect(nav).toHaveAttribute("data-expanded", "false");
    await page.keyboard.press("Tab");
    await expect(nav).toHaveAttribute("data-expanded", "true");
  });

  test("keeps DemoContent mounted and loading state intact when Clerk resolves signed-in @demo", async ({ page }) => {
    let releaseClerk!: () => void;
    const clerkReady = new Promise<void>((resolve) => {
      releaseClerk = resolve;
    });
    let releaseStartDemo!: () => void;
    const demoStarted = new Promise<void>((resolve) => {
      releaseStartDemo = resolve;
    });
    let startDemoPosts = 0;

    await isolate(page, {
      "/api/map/demo": async (route) => {
        if (route.request().method() === "POST") {
          startDemoPosts += 1;
          await demoStarted;
          return route.fulfill({ json: { job_id: "demo-transition-1" } });
        }
        return route.fulfill({ json: { count: 100, categories: { "amino acid": 40, lipid: 60 }, entity_type: "metabolite" } });
      },
      "/api/map/stream/demo-transition-1": (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: `event: progress\ndata: ${JSON.stringify({ job_id: "demo-transition-1", status: "complete", completed: 1, total: 1, error_count: 0, results: [] })}\n\n`,
        }),
      "/api/map/result/demo-transition-1": { job_id: "demo-transition-1", status: "complete", completed: 1, total: 1, error_count: 0, results: [] },
    });

    await page.route(/clerk\.browser\.js/, async (route) => {
      await clerkReady;
      return route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: `
          window.Clerk = {
            loaded: true,
            user: { id: "user_test", primaryEmailAddress: { emailAddress: "researcher@phenomehealth.org" } },
            session: { id: "sess_test" },
            client: { signedInSessions: [{ id: "sess_test" }] },
            __internal_lastEmittedResources: {
              user: { id: "user_test", primaryEmailAddress: { emailAddress: "researcher@phenomehealth.org" } },
              session: { id: "sess_test" },
              client: { signedInSessions: [{ id: "sess_test" }] },
              organization: null,
            },
            addListener(cb) {
              cb(this.__internal_lastEmittedResources);
              return () => {};
            },
            signOut: async () => {},
          };
        `,
      });
    });

    await page.goto("/demo", { waitUntil: "domcontentloaded" });
    await page.mouse.move(1200, 10);
    await expect(page.getByText("Demo Mode")).toBeAttached();
    const startButton = page.getByRole("button", { name: "Start Demo" });
    await expect(startButton).toBeEnabled();

    // Start the demo before Clerk finishes loading; button enters loading state.
    await startButton.click();
    const loadingButton = page.getByRole("button", { name: "Starting Demo..." });
    await expect(loadingButton).toBeVisible();
    await expect(loadingButton).toBeDisabled();

    // Clerk resolves signed-in: AdaptiveShell switches to app mode without remounting DemoContent.
    releaseClerk();
    await expect(page.getByTestId("app-nav").getByRole("link", { name: "BioMapper home" })).toHaveAttribute("href", "/");
    await expect(page.getByText("Demo Mode")).toHaveCount(0);
    await expect(loadingButton).toBeVisible();
    await expect(loadingButton).toBeDisabled();
    expect(startDemoPosts).toBe(1);

    releaseStartDemo();
    await expect(page).toHaveURL(/\/job\/demo-transition-1\?demo=true$/);
    await expect(page.getByTestId("app-nav").getByRole("link", { name: "Job: demo-tra..." })).toHaveAttribute(
      "href",
      "/job/demo-transition-1?demo=true",
    );
  });

  test("screenshot of the demo page @demo", async ({ browser }) => {
    test.skip(!TAKE_SCREENSHOTS, "set SHELL_SCREENSHOTS=1 to refresh the PR screenshots");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, baseURL: test.info().project.use.baseURL });
    await isolate(page);
    await goto(page, "/demo");
    await expect(page.getByRole("heading", { name: "See BioMapper in Action" })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "shell-demo.png") });
    await page.close();
  });
});

test.describe("app shell @app", () => {
  test("rail and every existing destination on the upload page", async ({ page }) => {
    const googleFontRequests = await isolate(page);
    await goto(page, "/");

    await expectRailExpandsWithoutReflow(page);

    const nav = page.getByTestId("app-nav");
    await expect(nav.getByRole("link", { name: "BioMapper home" })).toHaveAttribute("href", "/");
    await expect(nav.getByRole("link", { name: "New job" })).toHaveAttribute("href", "/upload");
    await expect(nav.getByRole("link", { name: "Benchmark" })).toHaveAttribute("href", "/benchmark");
    await expect(nav.getByRole("link", { name: "Flagged Annotations" })).toHaveAttribute("href", "/flagged");
    // Recent jobs: named jobs by name, unnamed ones by their short id, then the full history.
    await expect(nav.getByRole("link", { name: "Arivale metabolon panel" })).toHaveAttribute("href", `/job/${JOBS[0].jobId}`);
    await expect(nav.getByRole("link", { name: "bbbbbbbb..." })).toHaveAttribute("href", `/job/${JOBS[1].jobId}`);
    await expect(nav.getByRole("link", { name: "View all" })).toHaveAttribute("href", "/jobs");
    // Controls that lived in the old top bar, now at the rail's foot.
    await expect(nav.getByRole("button", { name: "Sign out" })).toBeAttached();
    await expect(nav.getByRole("group", { name: "API environment" })).toBeAttached();
    // The floating feedback button is unchanged.
    await expect(page.getByRole("button", { name: "Submit feedback" })).toBeVisible();

    await expectSelfHostedInter(page, googleFontRequests);
  });

  test("demo page renders inside AppShell in signed-in/bypass mode @app", async ({ page }) => {
    await isolate(page);
    await goto(page, "/demo");
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await expect(page.getByRole("heading", { name: "See BioMapper in Action" })).toBeVisible();
    await expect(page.getByTestId("app-nav").getByRole("link", { name: "BioMapper home" })).toHaveAttribute("href", "/");
    await expect(page.getByText("Demo Mode")).toHaveCount(0);
  });

  test("active job rail link preserves ?demo=true in signed-in/bypass mode @app", async ({ page }) => {
    const jobId = JOBS[0].jobId;
    await isolate(page, {
      [`/api/map/stream/${jobId}`]: (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: `event: progress\ndata: ${JSON.stringify({ job_id: jobId, status: "complete", completed: 1, total: 1, error_count: 0, results: [] })}\n\n`,
        }),
      [`/api/map/result/${jobId}`]: { job_id: jobId, status: "complete", completed: 1, total: 1, error_count: 0, results: [] },
    });
    await goto(page, `/job/${jobId}?demo=true`);
    const nav = page.getByTestId("app-nav");
    const activeJobLink = nav.getByRole("link", { name: `Job: ${jobId.slice(0, 8)}...` });
    await expect(activeJobLink).toHaveAttribute("href", `/job/${jobId}?demo=true`);
    await expect(activeJobLink).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: JOBS[0].displayName! })).not.toHaveAttribute("aria-current", "page");
  });

  test("screenshot of the upload page @app", async ({ browser }) => {
    test.skip(!TAKE_SCREENSHOTS, "set SHELL_SCREENSHOTS=1 to refresh the PR screenshots");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, baseURL: test.info().project.use.baseURL });
    await isolate(page);
    await goto(page, "/upload");
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "shell-upload.png") });
    await page.close();
  });
});
