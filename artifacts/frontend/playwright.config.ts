import { defineConfig } from "@playwright/test";

// Shell smoke tests run against two Vite dev servers and no backend: every /api call is answered by a
// Playwright route in the spec, and every non-local request is stubbed or aborted, so the suite needs no
// network. The publishable key below is a syntactically valid DUMMY that only satisfies App.tsx's presence
// check; it names no real Clerk instance and is never used outside e2e. It is built here rather than written
// out so secret scanners do not flag a key-shaped literal.
const DUMMY_CLERK_KEY = `pk_test_${Buffer.from("example.clerk.accounts.dev$").toString("base64")}`;

// E2E_PORT_BASE moves both dev servers (base and base + 1) so several checkouts can run e2e at once. When it is
// set, a server already on those ports is never reused: it may belong to another checkout.
const PORT_BASE = process.env.E2E_PORT_BASE ? Number(process.env.E2E_PORT_BASE) : undefined;
const APP_PORT = PORT_BASE ?? 5191;
const BYPASS_PORT = PORT_BASE !== undefined ? PORT_BASE + 1 : 5192;

function server(port: number, extraEnv: Record<string, string> = {}) {
  return {
    // Plain `vite`: `pnpm run e2e` puts node_modules/.bin on PATH, and npx would add npm config warnings.
    command: "vite --config vite.config.ts --strictPort",
    url: `http://localhost:${port}/`,
    reuseExistingServer: PORT_BASE === undefined && !process.env.CI,
    timeout: 120_000,
    env: {
      PORT: String(port),
      BASE_PATH: "/",
      VITE_CLERK_PUBLISHABLE_KEY: DUMMY_CLERK_KEY,
      ...extraEnv,
    },
  };
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Locally a flake must fail loudly; CI gets one retry, and the trace below is kept for any failure.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    viewport: { width: 1440, height: 900 },
    // A failing test leaves a trace (test-results/<test>/trace.zip) to open with `playwright show-trace`.
    trace: "retain-on-failure",
    // Playwright's headless Chromium passes --hide-scrollbars, which would make every scroll bar invisible and the
    // scroll.spec.ts checks meaningless. Real users see bars, so the tests must too.
    launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
  },
  projects: [
    {
      // The unauthenticated surface: /demo renders DemoShell with no sign-in.
      name: "app",
      use: { baseURL: `http://localhost:${APP_PORT}` },
      testMatch: /(shell|scroll)\.spec\.ts/,
      grep: /@demo/,
    },
    {
      // The signed-in surface: the dev-only auth bypass in App.tsx renders AppShell without a Clerk session.
      name: "bypass",
      use: { baseURL: `http://localhost:${BYPASS_PORT}` },
      testMatch: /(shell|scroll)\.spec\.ts/,
      grep: /@app/,
    },
  ],
  webServer: [
    server(APP_PORT),
    server(BYPASS_PORT, { VITE_DEV_BYPASS_AUTH: "true" }),
  ],
});
