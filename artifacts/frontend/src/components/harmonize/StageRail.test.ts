import { describe, expect, it } from "vitest";
import type { HarmonizeRunStatus } from "@workspace/api-client-react";
import { stepViews } from "./StageRail";

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
