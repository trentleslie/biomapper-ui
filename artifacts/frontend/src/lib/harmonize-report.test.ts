import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { armSummary, diffView, excluded, identifierSkipped, nameLinking, pins, reportLabels, statusAndGrade, warnings, type Report } from "./harmonize-report";

// The recorded example runs committed with the backend: the real report.json shapes the screen reads.
const EXAMPLES = path.resolve(import.meta.dirname, "../../../python-api/data/harmonize_examples");
const load = (kind: string): Report => JSON.parse(readFileSync(path.join(EXAMPLES, kind, "recording", "report.json"), "utf-8"));

describe("two-cohort report", () => {
  const report = load("two_cohort");
  it("reads both arms side by side", () => {
    expect(reportLabels(report)).toEqual(["example_cohort_a", "example_cohort_b"]);
    const names = armSummary(report, "names_only");
    expect(names.skipped).toBe(false);
    expect(names.headline.find((c) => c.label === "Links")?.value).toBe(29);
    expect(names.headline.find((c) => c.label === "Ambiguous")?.value).toBe(2);
    expect(names.perCohort[0].counts.find((c) => c.label === "Unresolved")?.value).toBe(1);
    expect(armSummary(report, "identifier").skipped).toBe(false);
  });
  it("reads the diff, name linking, warnings, excluded rows and pins", () => {
    const diff = diffView(report);
    expect(diff?.counts.map((c) => c.value)).toEqual([0, 0, 29]);
    expect(diff?.sets[2].entries[0]).toBe("a01 with b01 (Glucose and D-Glucose)");
    expect(nameLinking(report)?.enabled).toBe(true);
    expect(warnings(report)[0]).toMatch(/^KEGG is declared only/);
    expect(excluded(report).every((c) => c.rows.length === 0)).toBe(true);
    const p = pins(report, { kgBuild: "2.3.0 (3dd08a5b)", kgVerified: true });
    expect(p.map((x) => x.label)).toEqual(["biomapper", "Mapping API", "Kestrel", "Knowledge graph build", "KG build (run status)"]);
    expect(p[0].value).toBe("1.9.0");
  });
  it("says when the identifier arm was skipped, with the reason", () => {
    const skipped = { ...report, arms: { ...(report.arms as object), identifier: null }, identifier_skipped_reason: "The cohorts share no identifier vocabulary." };
    expect(identifierSkipped(skipped)).toEqual({ skipped: true, reason: "The cohorts share no identifier vocabulary." });
    expect(armSummary(skipped, "identifier")).toMatchObject({ skipped: true, reason: "The cohorts share no identifier vocabulary." });
  });
});

describe("many-cohort report", () => {
  const report = load("many_cohort");
  it("reads groups, status and grade, and membership changes", () => {
    const id = armSummary(report, "identifier");
    expect(id.headline.find((c) => c.label === "Groups")?.value).toBe(27);
    expect(id.headline.find((c) => c.label === "Cross-node entries")?.value).toBe(1);
    expect(id.perCohort).toHaveLength(5);
    expect(statusAndGrade(report)).toEqual({ status: "ok", grade: "iteration-grade, not for publication" });
    const diff = diffView(report);
    expect(diff?.sets.map((s) => s.key)).toContain("membership_changed");
    expect(diff?.counts.find((c) => c.label.startsWith("Groups whose"))?.value).toBe(2);
  });
});
