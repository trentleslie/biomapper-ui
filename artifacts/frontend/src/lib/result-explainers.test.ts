import { describe, expect, it } from "vitest";
import { confidenceTierCounts } from "./result-explainers";

describe("confidenceTierCounts", () => {
  it("counts a resolved unscored row as not scored and ignores an unresolved row", () => {
    const counts = confidenceTierCounts([
      { resolved: true, confidenceTier: "unknown" },
      { resolved: false, confidenceTier: "unknown" },
    ]);
    expect(counts.unknown).toBe(1);
    expect(counts).toEqual({ high: 0, medium: 0, low: 0, unknown: 1 });
  });

  it("counts resolved rows by tier", () => {
    const counts = confidenceTierCounts([
      { resolved: true, confidenceTier: "high" },
      { resolved: true, confidenceTier: "low" },
      { resolved: true, confidenceTier: null },
    ]);
    expect(counts).toEqual({ high: 1, medium: 0, low: 1, unknown: 1 });
  });
});
