import type { Page, Route } from "@playwright/test";

export const JOBS = [
  { jobId: "aaaaaaaa-0000-0000-0000-000000000001", displayName: "Arivale metabolon panel", status: "completed", total: 10, completed: 10, errorCount: 0, env: "production", createdAt: 1_700_000_000, updatedAt: 1_700_000_100 },
  { jobId: "bbbbbbbb-0000-0000-0000-000000000002", displayName: null, status: "running", total: 10, completed: 4, errorCount: 0, env: "production", createdAt: 1_700_000_200, updatedAt: 1_700_000_300 },
];

/** A canned answer for one /api path: a JSON body, or a function that fulfils the route itself. */
export type Stub = unknown | ((route: Route, url: URL) => Promise<void> | void);

/**
 * No backend and no network: the app's own /api calls get canned answers, Google Fonts requests are recorded and
 * answered with an empty stylesheet (so a test can assert none of them asks for Inter), and every other
 * non-local request (Clerk's script, gstatic) is aborted.
 *
 * `stubs` maps an exact /api pathname to its answer and wins over the defaults below.
 */
export async function isolate(page: Page, stubs: Record<string, Stub> = {}) {
  const googleFontRequests: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (url.pathname in stubs) {
        const stub = stubs[url.pathname];
        if (typeof stub === "function") return stub(route, url);
        return route.fulfill({ json: stub });
      }
      if (url.pathname === "/api/jobs") return route.fulfill({ json: JOBS });
      if (url.pathname === "/api/discovery/entity-types") {
        return route.fulfill({ json: [{ type: "metabolite", defaultPrefixes: ["HMDB", "CHEBI", "PUBCHEM.COMPOUND"] }] });
      }
      if (url.pathname === "/api/discovery/annotators") {
        return route.fulfill({ json: [{ slug: "kestrel", name: "Kestrel" }] });
      }
      if (url.pathname === "/api/discovery/vocabularies") {
        return route.fulfill({ json: [{ prefix: "HMDB" }, { prefix: "CHEBI" }, { prefix: "PUBCHEM.COMPOUND" }] });
      }
      if (url.pathname === "/api/map/demo") {
        return route.fulfill({ json: { count: 100, categories: { "amino acid": 40, lipid: 60 }, entity_type: "metabolite" } });
      }
      return route.fulfill({ json: {} });
    }
    if (url.hostname === "fonts.googleapis.com") {
      googleFontRequests.push(url.toString());
      return route.fulfill({ status: 200, contentType: "text/css", body: "" });
    }
    return route.abort();
  });
  return googleFontRequests;
}
