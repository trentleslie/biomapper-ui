import { describe, expect, it, vi } from "vitest";
import { ExportError, exportUrl, fetchExport } from "./harmonize-export";
import { stepViews } from "@/components/harmonize/StageRail";
import type { HarmonizeRunStatus } from "@workspace/api-client-react";

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
});

describe("stage rail", () => {
  const run = (state: string, extra: Partial<HarmonizeRunStatus> = {}) =>
    ({ jobId: "j", state, kind: "harmonize_cohorts", labels: ["a", "b"], entity: "metabolites", createdAt: "", ...extra }) as HarmonizeRunStatus;

  it("before a run, only setup is open", () => {
    const v = stepViews("setup", null, null);
    expect(v.map((s) => s.state)).toEqual(["current", "locked", "locked", "locked"]);
  });

  it("while running, review and export are locked and the run step shows the arm's progress", () => {
    const v = stepViews(
      "run",
      run("running", { progress: { function: "harmonize_cohorts", arm: "names_only", entitiesDone: 15, entitiesTotal: 30 } }),
      null,
    );
    expect(v.map((s) => s.state)).toEqual(["done", "current", "locked", "locked"]);
    expect(v[1].status).toBe("Running: Names-only arm 50%");
  });

  it("once complete, every step opens and review shows the flagged count", () => {
    const v = stepViews("review", run("complete"), 5);
    expect(v.map((s) => s.state)).toEqual(["done", "done", "current", "open"]);
    expect(v[2].status).toBe("5 items flagged");
  });
});
