import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  RUN_STATES,
  armDiff,
  armProgress,
  armSummary,
  canCancel,
  canResume,
  describeItem,
  distinctLabels,
  errorMessage,
  excludedRows,
  filenameFromDisposition,
  guessKeyColumn,
  guessNameColumn,
  inferVocabulary,
  labelFromName,
  manyCountMessage,
  missingColumns,
  nameLinking,
  pollInterval,
  pyRepr,
  reportLabels,
  stateInfo,
  toCohortInput,
  tooLargeMessage,
  versionPins,
  warnings,
  type Report,
} from "./harmonize";

// The committed recordings: real runs of the built-in examples against the hosted API.
const EXAMPLES = path.resolve(import.meta.dirname, "../../../python-api/data/harmonize_examples");
const load = (kind: string): Report => JSON.parse(readFileSync(path.join(EXAMPLES, kind, "recording/report.json"), "utf-8"));
const two = load("two_cohort");
const many = load("many_cohort");

describe("run states", () => {
  it("has a word for every state the package reports, and never a blank one", () => {
    for (const s of ["queued", "running", "complete", "partial", "stalled", "paused", "expired", "cancelled", "failed", "owned_elsewhere", "unknown"]) {
      expect(stateInfo(s).word).toBeTruthy();
      expect(stateInfo(s).word).not.toMatch(/undefined/);
    }
    expect(stateInfo(undefined).word).toBe("unknown");
    expect(stateInfo(null).word).toBe("unknown");
    expect(stateInfo("").word).toBe("unknown");
    expect(stateInfo("brand_new").word).toBe("brand new");
    expect(Object.keys(RUN_STATES)).toHaveLength(11);
  });

  it("offers resume and cancel only where the package allows them", () => {
    expect(canResume("harmonize_cohorts", "cancelled")).toBe(true);
    expect(canResume("harmonize_many", "stalled")).toBe(true);
    expect(canResume("harmonize_cohorts", "failed")).toBe(false);
    expect(canResume("harmonize_cohorts", "complete")).toBe(false);
    expect(canCancel("harmonize_cohorts", "running")).toBe(true);
    expect(canCancel("harmonize_cohorts", "complete")).toBe(false);
    // A run from finished jobs has no backend job.
    expect(canCancel("harmonize_results", "running")).toBe(false);
    expect(canResume("harmonize_results", "cancelled")).toBe(false);
  });

  it("polls quickly while a run moves by itself and stops once it is finished", () => {
    expect(pollInterval("running")).toBe(2000);
    expect(pollInterval("queued")).toBe(2000);
    expect(pollInterval("paused")).toBe(10000);
    expect(pollInterval("complete")).toBe(false);
    expect(pollInterval("failed")).toBe(false);
  });
});

describe("armProgress", () => {
  it("uses the current arm's done out of total, never over 100 percent", () => {
    expect(armProgress({ function: "f", arm: "names_only", entitiesDone: 10, entitiesTotal: 30 })).toEqual({
      arm: "names_only", done: 10, total: 30, percent: 33,
    });
    // A live run can report more done than total; the readout is clamped.
    expect(armProgress({ function: "f", arm: "identifier", entitiesDone: 107, entitiesTotal: 53 })?.percent).toBe(100);
    expect(armProgress({ function: "f", arm: "review", entitiesDone: 0, entitiesTotal: 0 })?.percent).toBe(0);
    expect(armProgress(null)).toBeNull();
  });
});

describe("cohort setup", () => {
  it("makes labels from file names that pass the label rule, distinct within a run", () => {
    expect(labelFromName("My Cohort (2024).tsv")).toBe("My_Cohort_2024");
    expect(labelFromName("###.csv")).toBe("cohort");
    expect(distinctLabels(["a.tsv", "a.csv", "b.tsv", "a.txt"])).toEqual(["a", "a_2", "b", "a_3"]);
  });

  it("guesses the name and key columns and identifier vocabularies from the header", () => {
    expect(guessNameColumn(["id", "name", "hmdb"])).toBe("name");
    expect(guessNameColumn(["CHEM_ID", "BIOCHEMICAL", "HMDB"])).toBe("BIOCHEMICAL");
    expect(guessKeyColumn(["id", "name", "hmdb"], "name")).toBe("id");
    expect(guessKeyColumn(["name", "hmdb"], "name")).toBe("");
    expect(inferVocabulary("hmdb_id")).toBe("HMDB");
    expect(inferVocabulary("KEGG")).toBe("KEGG");
    expect(inferVocabulary("notes")).toBeNull();
  });

  it("groups identifier columns by vocabulary and leaves out an unset key column", () => {
    expect(
      toCohortInput({ label: " a ", nameColumn: "name", keyColumn: "", idColumns: { hmdb: "HMDB", hmdb2: "HMDB", kegg: "KEGG", x: " " } }),
    ).toEqual({ label: "a", nameColumn: "name", vocabularies: { HMDB: ["hmdb", "hmdb2"], KEGG: ["kegg"] } });
    expect(toCohortInput({ label: "b", nameColumn: "n", keyColumn: "id", idColumns: {} }).keyColumn).toBe("id");
  });

  it("words refusals exactly as the backend does", () => {
    expect(
      missingColumns({ label: "a", nameColumn: "name", keyColumn: "", idColumns: { zzz: "HMDB" } }, "a.tsv", ["name", "hmdb"]),
    ).toEqual(["Column 'zzz' is not in file 'a.tsv'. Columns found: name, hmdb."]);
    expect(manyCountMessage(1)).toBe("A many-cohort run takes 2 to 12 cohort files (got 1).");
    expect(manyCountMessage(13)).toBe("A many-cohort run takes 2 to 12 cohort files (got 13).");
    expect(tooLargeMessage("a.tsv")).toBe("'a.tsv' is larger than the 50 MB limit.");
    expect(pyRepr("it's.tsv")).toBe('"it\'s.tsv"');
  });
});

describe("errors and downloads", () => {
  it("shows the API's detail as written", () => {
    expect(errorMessage({ status: 400, data: { detail: "Cohort labels must be distinct (got a, a)." } })).toBe(
      "Cohort labels must be distinct (got a, a).",
    );
    expect(errorMessage({ data: { detail: [{ msg: "Field required" }, { msg: "Extra inputs are not permitted" }] } })).toBe(
      "Field required; Extra inputs are not permitted",
    );
    expect(errorMessage(new Error("Failed to fetch"))).toBe("Failed to fetch");
  });

  it("reads the file name from Content-Disposition", () => {
    expect(filenameFromDisposition('attachment; filename="harmonize_cohorts_a_b_links.csv"', "x")).toBe("harmonize_cohorts_a_b_links.csv");
    expect(filenameFromDisposition("attachment; filename*=UTF-8''a%20b.json", "x")).toBe("a b.json");
    expect(filenameFromDisposition(null, "links.csv")).toBe("links.csv");
  });
});

describe("reading the two-cohort recording", () => {
  it("has its labels, both arms and the links count", () => {
    expect(reportLabels(two)).toEqual(["example_cohort_a", "example_cohort_b"]);
    const names = armSummary(two, "names_only")!;
    expect(names.main).toBe(29);
    expect(names.facts.find((f) => f.label === "Ambiguous links")?.value).toBe(2);
    expect(names.cohorts.map((c) => [c.label, c.total, c.placed, c.unresolved])).toEqual([
      ["example_cohort_a", 30, 29, 1],
      ["example_cohort_b", 30, 28, 1],
    ]);
    expect(names.byBasis.find((b) => b.basis === "node")?.count).toBe(29);
    expect(armSummary(two, "identifier")?.main).toBe(29);
  });

  it("describes the diff with names next to keys", () => {
    const d = armDiff(two)!;
    expect(d.counts.map((c) => c.value)).toEqual([0, 0, 29]);
    expect(d.sets[2].entries[0]).toBe("Glucose (a01) with D-Glucose (b01)");
    expect(d.sets).toHaveLength(3);
  });

  it("states name linking, warnings, no excluded rows and the version pins", () => {
    expect(nameLinking(two)).toMatchObject({ enabled: true, decidedBy: "category" });
    expect(warnings(two)).toHaveLength(1);
    expect(excludedRows(two)).toMatchObject({ reported: true, total: 0 });
    const pins = versionPins(two, { kgBuild: "2.3.0 (3dd08a5b)", kgVerified: true });
    expect(pins.find((p) => p.label === "biomapper")?.value).toBe("1.9.0");
    expect(pins.find((p) => p.label === "Kestrel")?.value).toBe("0.5.0");
    expect(pins.find((p) => p.label === "Knowledge graph build")?.value).toContain("version 2.3.0");
    expect(pins.find((p) => p.label === "KG build (run status)")?.value).toBe("2.3.0 (3dd08a5b), verified");
  });
});

describe("reading the many-cohort recording", () => {
  it("counts groups per arm and per cohort", () => {
    expect(reportLabels(many)).toHaveLength(5);
    const ident = armSummary(many, "identifier")!;
    expect(ident.main).toBe(27);
    expect(ident.facts.find((f) => f.label === "Groups with multiplicity")?.value).toBe(2);
    expect(ident.facts.find((f) => f.label === "Cross-node entries")?.value).toBe(1);
    expect(ident.cohorts[0]).toMatchObject({ label: "example_cohort_a", total: 16, placed: 15, unresolved: 1, noNode: 0 });
  });

  it("includes the membership-changed groups in the diff, named by their members", () => {
    const d = armDiff(many)!;
    expect(d.counts.find((c) => c.key === "membership_changed")?.value).toBe(2);
    const changed = d.sets.find((s) => s.key === "membership_changed")!;
    expect(changed.entries).toHaveLength(2);
    expect(changed.entries[0]).toMatch(/^RM:0028430 \(/);
  });

  it("reports a skipped identifier arm as absent, not empty", () => {
    const skipped: Report = { ...many, arms: { names_only: (many.arms as Record<string, unknown>).names_only } };
    expect(armSummary(skipped, "identifier")).toBeNull();
  });
});

describe("a run from finished jobs", () => {
  const results: Report = {
    schema_version: 1,
    kind: "harmonize_results",
    labels: ["seed_a", "seed_b"],
    name_linking: { enabled: false, decided_by: "user", reason: "Off." },
    arms: {
      names_only: {
        labels: { a: "seed_a", b: "seed_b" },
        summary: { n_links: 4, seed_a: { total: 5, linked: 4, unresolved: 0, errors: 0 }, seed_b: { total: 5, linked: 4, unresolved: 1, errors: 0 } },
        links: [],
      },
      identifier: null,
    },
  };
  it("has one arm and says what it does not record", () => {
    expect(armSummary(results, "names_only")?.main).toBe(4);
    expect(armSummary(results, "identifier")).toBeNull();
    expect(armDiff(results)).toBeNull();
    expect(excludedRows(results).reported).toBe(false);
    expect(warnings(results)).toBeNull();
    expect(versionPins(results, { kgBuild: "unknown", kgVerified: false })).toEqual([]);
    expect(nameLinking(results)).toEqual({ enabled: false, reason: "Off.", decidedBy: "user" });
  });
});

describe("describeItem", () => {
  it("tells one-to-one from ambiguous links and gives basis and partners", () => {
    expect(describeItem("link", { basis: "node", ambiguous: true, aPartners: 2, bPartners: 1 })).toEqual([
      "Ambiguous", "Basis: node (same node)", "Partners: 2 and 1",
    ]);
    expect(describeItem("link", { basis: "name_exact", ambiguous: false, oneToOne: true, aPartners: 1, bPartners: 1 })[0]).toBe("One-to-one");
  });
  it("names groups, review entries and unresolved rows", () => {
    expect(describeItem("group", { node: "RM:1", clean: false, multiplicity: true, cohorts: ["a", "b"] })).toEqual([
      "Node RM:1", "multiplicity", "2 cohorts",
    ]);
    expect(describeItem("review", { origin: "review_queue", vocabulary: "KEGG", code: "C00031", status: "disagree" })).toEqual([
      "One-sided identifier check", "KEGG C00031: disagree",
    ]);
    expect(describeItem("review", { origin: "cross_node", nodeA: "RM:1", nodeB: "RM:2" })[1]).toBe("RM:1 and RM:2");
    expect(describeItem("unresolved", { bucket: "errored", error: "timeout" })).toEqual(["Errored", "timeout"]);
    expect(describeItem("unresolved", { bucket: "no_node" })).toEqual(["Resolved, no node"]);
  });
});
