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
    await expect(nav.getByRole("link", { name: "New job" })).toHaveAttribute("href", "/");
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

  test("screenshot of the upload page @app", async ({ browser }) => {
    test.skip(!TAKE_SCREENSHOTS, "set SHELL_SCREENSHOTS=1 to refresh the PR screenshots");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, baseURL: test.info().project.use.baseURL });
    await isolate(page);
    await goto(page, "/");
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "shell-upload.png") });
    await page.close();
  });
});
