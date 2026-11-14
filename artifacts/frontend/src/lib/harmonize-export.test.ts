import { describe, expect, it, vi } from "vitest";
import { ExportError, exportUrl, fetchExport } from "./harmonize-export";

function response(body: string, init: ResponseInit) {
  return new Response(body, init);
}

describe("fetchExport", () => {
  it("asks for the table and format and reads the file name and skipped count from the headers", async () => {
    const fetchImpl = vi.fn(async () =>
      response("[]", {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": 'attachment; filename="harmonize_cohorts_a_b_eitl_pairs.json"',
          "X-Harmonize-Skipped-One-Sided": "1",
        },
      }),
    );
    const file = await fetchExport("job1", "eitl_pairs", "json", { env: "production", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringMatching(/\/api\/harmonize\/runs\/job1\/export\?table=eitl_pairs&format=json$/), {
      headers: { "X-Biomapper-Env": "production" },
    });
    expect(file.filename).toBe("harmonize_cohorts_a_b_eitl_pairs.json");
    expect(file.skipped).toBe(1);
    expect(await file.blob.text()).toBe("[]");
  });

  it("has no skipped count for other tables", async () => {
    const fetchImpl = async () => response("ref\r\n", { status: 200, headers: { "X-Harmonize-Skipped-One-Sided": "3" } });
    const file = await fetchExport("job1", "links", "csv", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(file.skipped).toBeNull();
    expect(file.filename).toBe("harmonize_links.csv");
  });

  it("throws the server's message as written", async () => {
    const fetchImpl = async () =>
      response(JSON.stringify({ detail: "The EITL pairs file is CSV or JSON: the expert-in-the-loop upload does not read TSV." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    await expect(fetchExport("job1", "eitl_pairs", "tsv" as never, { fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toEqual(
      new ExportError("The EITL pairs file is CSV or JSON: the expert-in-the-loop upload does not read TSV.", 400),
    );
  });

  it("encodes the job id", () => {
    expect(exportUrl("a/b", "links", "csv")).toMatch(/runs\/a%2Fb\/export/);
  });

  it("builds the same URL as the generated client, with no base path prefix", () => {
    expect(exportUrl("job1", "eitl_pairs", "json")).toBe("/api/harmonize/runs/job1/export?table=eitl_pairs&format=json");
  });

  it("refuses a 200 web page: under a wrong base the site's own page would be saved as the export", async () => {
    const fetchImpl = async () => response("<!doctype html><html></html>", { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
    await expect(fetchExport("job1", "links", "csv", { fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow(
      "The server answered with a web page instead of the file. The download was not saved.",
    );
  });

  it("turns a proxy's HTML error page into a sentence from the status", async () => {
    const fetchImpl = async () => response("<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>", { status: 502, headers: { "Content-Type": "text/html" } });
    await expect(fetchExport("job1", "links", "csv", { fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow(
      "The server is unavailable or did not answer in time (HTTP 502). Try again in a moment.",
    );
  });

  it("says the server could not be reached when fetch itself fails", async () => {
    const fetchImpl = async () => {
      throw new TypeError("Failed to fetch");
    };
    await expect(fetchExport("job1", "links", "csv", { fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow(
      "Could not reach the server. Check your connection, then try again.",
    );
  });
});
