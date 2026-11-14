import { describe, expect, it } from "vitest";
import twoReport from "../../../python-api/data/harmonize_examples/two_cohort/recording/report.json";
import manyReport from "../../../python-api/data/harmonize_examples/many_cohort/recording/report.json";
import {
  STATE_INFO,
  armData,
  armProgress,
  canCancel,
  canResume,
  categoryOrNull,
  cohortCounts,
  cohortInput,
  defaultStage,
  distinctLabel,
  errorMessage,
  excludedRows,
  filenameFromDisposition,
  guessKeyColumn,
  guessNameColumn,
  guessVocabulary,
  headerColumns,
  headerProblems,
  hasResults,
  identifierSkippedReason,
  itemSummary,
  labelFromFilename,
  manyCountMessage,
  nameLinking,
  pinRows,
  prefillDraft,
  reportLabels,
  skippedFromHeader,
  stageReachable,
  stateInfo,
  tableApplies,
  unresolvedRows,
  vocabulariesFromColumns,
  type Json,
} from "./harmonize";

const two = twoReport as unknown as Json;
const many = manyReport as unknown as Json;

describe("run states", () => {
  it("words every state the package reports, and unknown", () => {
    const states = ["queued", "running", "complete", "partial", "stalled", "paused", "expired", "cancelled", "failed", "owned_elsewhere", "unknown"];
    for (const s of states) {
      const label = stateInfo(s).label;
      expect(label).toBeTruthy();
      expect(label).not.toMatch(/undefined/i);
    }
    expect(Object.keys(STATE_INFO).sort()).toEqual([...states].sort());
    expect(stateInfo("owned_elsewhere").label).toBe("Owned elsewhere");
  });

  it("never shows blank for a missing or unexpected state", () => {
    expect(stateInfo(undefined).label).toBe("Unknown");
    expect(stateInfo("brand_new_state").label).toBe("Brand new state");
  });

  it("offers cancel on unfinished runs and resume on cancelled, paused, stalled or expired ones", () => {
    const run = (state: string, kind = "harmonize_cohorts") => ({ state, kind }) as Parameters<typeof canCancel>[0];
    expect(canCancel(run("running"))).toBe(true);
    expect(canCancel(run("queued"))).toBe(true);
    expect(canCancel(run("complete"))).toBe(false);
    expect(canCancel(run("cancelled"))).toBe(false);
    for (const s of ["cancelled", "paused", "stalled", "expired"]) expect(canResume(run(s))).toBe(true);
    expect(canResume(run("running"))).toBe(false);
    expect(canResume(run("cancelled", "harmonize_results"))).toBe(false);
    expect(canCancel(run("running", "harmonize_results"))).toBe(false);
  });

  it("opens finished runs on review and others on their progress; review and export wait for results", () => {
    expect(hasResults("complete")).toBe(true);
    expect(hasResults("partial")).toBe(true);
    expect(hasResults("failed")).toBe(false);
    expect(defaultStage("partial")).toBe("review");
    expect(defaultStage("running")).toBe("run");
    expect(stageReachable("review", "running")).toBe(false);
    expect(stageReachable("export", "cancelled")).toBe(false);
    expect(stageReachable("setup", "running")).toBe(true);
    expect(stageReachable("export", "complete")).toBe(true);
  });
});

describe("armProgress", () => {
  it("is the current arm's done out of its total", () => {
    const p = armProgress({ function: "harmonize_cohorts", arm: "identifier", entitiesDone: 10, entitiesTotal: 40 });
    expect(p).toEqual({ arm: "identifier", done: 10, total: 40, percent: 25 });
  });

  it("never exceeds 100 percent", () => {
    const p = armProgress({ function: "harmonize_many", arm: "names_only", entitiesDone: 107, entitiesTotal: 53 });
    expect(p?.percent).toBe(100);
    expect(p?.done).toBe(53);
  });

  it("handles a zero total and no progress", () => {
    expect(armProgress({ function: "x", arm: "review", entitiesDone: 0, entitiesTotal: 0 })?.percent).toBe(0);
    expect(armProgress(null)).toBeNull();
  });
});

describe("errorMessage", () => {
  it("returns the server's detail as written", () => {
    const err = Object.assign(new Error("HTTP 400 Bad Request: Cohort labels must be distinct (got a, a)."), {
      data: { detail: "Cohort labels must be distinct (got a, a)." },
    });
    expect(errorMessage(err)).toBe("Cohort labels must be distinct (got a, a).");
  });

  it("joins a validation list", () => {
    const err = { data: { detail: [{ loc: ["body", "files"], msg: "Field required" }] } };
    expect(errorMessage(err)).toBe("files: Field required");
  });

  it("falls back to the error message, then a sentence", () => {
    expect(errorMessage(new Error("Network down"))).toBe("Network down");
    expect(errorMessage(null)).toMatch(/Try again/);
  });
});

describe("cohort setup", () => {
  it("derives labels the package accepts and keeps them distinct", () => {
    expect(labelFromFilename("My Cohort (2024).tsv")).toBe("My_Cohort_2024");
    expect(labelFromFilename(".tsv")).toBe("cohort");
    expect(distinctLabel("a", ["a", "a_2"])).toBe("a_3");
    expect(distinctLabel("b", ["a"])).toBe("b");
  });

  it("guesses the name and key columns from the header", () => {
    expect(guessNameColumn(["id", "name", "hmdb"])).toBe("name");
    expect(guessNameColumn(["BIOCHEMICAL", "HMDB"])).toBe("BIOCHEMICAL");
    expect(guessNameColumn(["x", "y"])).toBe("x");
    expect(guessKeyColumn(["id", "name"], "name")).toBe("id");
    expect(guessKeyColumn(["name", "hmdb"], "name")).toBeUndefined();
  });

  it("guesses a vocabulary from a column name only when it matches one", () => {
    const vocabs = ["HMDB", "KEGG", "PUBCHEM.COMPOUND"];
    expect(guessVocabulary("hmdb", vocabs)).toBe("HMDB");
    expect(guessVocabulary("HMDB_ID", vocabs)).toBe("HMDB");
    expect(guessVocabulary("pubchem compound", vocabs)).toBe("PUBCHEM.COMPOUND");
    expect(guessVocabulary("platform", vocabs)).toBeUndefined();
  });

  it("groups columns per vocabulary and drops blanks", () => {
    expect(vocabulariesFromColumns({ hmdb: "HMDB", hmdb2: "HMDB", kegg: " ", id: "" })).toEqual({ HMDB: ["hmdb", "hmdb2"] });
  });

  it("builds a cohort spec with a null key column when none is chosen", () => {
    expect(cohortInput({ label: " a ", nameColumn: "name", keyColumn: "", vocabByColumn: { hmdb: "HMDB" } })).toEqual({
      label: "a",
      nameColumn: "name",
      keyColumn: null,
      vocabularies: { HMDB: ["hmdb"] },
    });
    expect(categoryOrNull("  ")).toBeNull();
    expect(categoryOrNull("biolink:Protein")).toBe("biolink:Protein");
  });

  it("prefills a first file and keeps the user's choices on a replaced file", () => {
    const blank = { label: "a", nameColumn: "", keyColumn: "", vocabByColumn: {} };
    const first = prefillDraft(blank, ["id", "name", "hmdb", "kegg"], ["HMDB", "KEGG"], true);
    expect(first).toEqual({ label: "a", nameColumn: "name", keyColumn: "id", vocabByColumn: { hmdb: "HMDB", kegg: "KEGG" } });
    const replaced = prefillDraft({ ...first, nameColumn: "zzz" }, ["id", "label"], ["HMDB"], false);
    expect(replaced.nameColumn).toBe("zzz");
    expect(replaced.vocabByColumn).toEqual({ hmdb: "HMDB", kegg: "KEGG" });
  });

  it("words the many-cohort count rule as the package does", () => {
    expect(manyCountMessage(1)).toBe("A many-cohort run takes 2 to 12 cohort files (got 1).");
    expect(manyCountMessage(13)).toBe("A many-cohort run takes 2 to 12 cohort files (got 13).");
    expect(manyCountMessage(5)).toBeNull();
  });
});

describe("report readers on the recorded runs", () => {
  it("reads labels for both kinds", () => {
    expect(reportLabels(two)).toEqual(["example_cohort_a", "example_cohort_b"]);
    expect(reportLabels(many)).toHaveLength(5);
  });

  it("reads per-cohort counts per arm", () => {
    const a = cohortCounts(two, "names_only")[0];
    expect(a).toMatchObject({ label: "example_cohort_a", total: 30, linked: 29, unresolved: 1, errors: 0 });
    const m = cohortCounts(many, "identifier")[0];
    expect(m).toMatchObject({ label: "example_cohort_a", total: 16, grouped: 15, unresolved: 1, noNode: 0, errors: 0 });
  });

  it("lists unresolved rows with key and name", () => {
    expect(unresolvedRows(two, "names_only")).toEqual([
      { cohort: "example_cohort_a", key: "a30", name: "###", bucket: "unresolved", error: null },
      { cohort: "example_cohort_b", key: "b30", name: "???", bucket: "unresolved", error: null },
    ]);
    expect(unresolvedRows(many, "names_only")).toHaveLength(5);
  });

  it("reads keys-only unresolved lists from finished-job runs", () => {
    const report = { kind: "harmonize_results", arms: { names_only: { unresolved: { A: ["k1"] }, errors: { A: ["k2"] } } } };
    expect(unresolvedRows(report, "names_only")).toEqual([
      { cohort: "A", key: "k1", name: null, bucket: "unresolved", error: null },
      { cohort: "A", key: "k2", name: null, bucket: "errored", error: null },
    ]);
  });

  it("treats a missing identifier arm as skipped, with the report's reason", () => {
    expect(armData(two, "identifier")).not.toBeNull();
    const skipped = { ...two, arms: { names_only: (two.arms as Json).names_only, identifier: null }, identifier_skipped_reason: "No shared vocabulary." };
    expect(armData(skipped, "identifier")).toBeNull();
    expect(identifierSkippedReason(skipped)).toBe("No shared vocabulary.");
  });

  it("reads name linking, excluded rows and pins", () => {
    expect(nameLinking(two)?.enabled).toBe(true);
    expect(nameLinking(two)?.reason).toMatch(/Name links are on/);
    expect(excludedRows(two).every((e) => e.rows.length === 0)).toBe(true);
    const pins = pinRows(two, { kgBuild: "2.3.0 (3dd08a5b)", kgVerified: true });
    expect(pins.find((p) => p.label === "biomapper")?.value).toBe("1.9.0");
    expect(pins.find((p) => p.label === "Knowledge graph build")?.value).toMatch(/KG 2\.3\.0/);
    expect(pins.find((p) => p.label === "Run status KG build")?.value).toBe("2.3.0 (3dd08a5b) (verified)");
  });
});

describe("items and exports", () => {
  it("describes links, groups, review entries and unresolved rows", () => {
    expect(itemSummary("link", { ambiguous: true, basis: "node", aPartners: 1, bPartners: 2 })).toEqual(["Ambiguous", "basis node", "partners 1 : 2"]);
    expect(itemSummary("group", { clean: false, multiplicity: true, node: "RM:1" })).toEqual(["Multiplicity", "node RM:1"]);
    expect(itemSummary("review", { origin: "possible_missed", reason: "possible_missed" })).toEqual(["Possible miss"]);
    expect(itemSummary("unresolved", { bucket: "errored", error: "timeout" })).toEqual(["Errored", "timeout"]);
  });

  it("reads the file name and the skipped count from export headers", () => {
    expect(filenameFromDisposition('attachment; filename="harmonize_cohorts_a_b_links.csv"')).toBe("harmonize_cohorts_a_b_links.csv");
    expect(filenameFromDisposition("attachment; filename*=UTF-8''a%20b.json")).toBe("a b.json");
    expect(filenameFromDisposition(null)).toBeNull();
    expect(skippedFromHeader("1")).toBe(1);
    expect(skippedFromHeader("0")).toBe(0);
    expect(skippedFromHeader("")).toBeNull();
    expect(skippedFromHeader("x")).toBeNull();
  });

  it("knows which tables hold rows for each kind", () => {
    expect(tableApplies("groups", "harmonize_cohorts")).toBe(false);
    expect(tableApplies("links", "harmonize_many")).toBe(false);
    expect(tableApplies("review", "harmonize_many")).toBe(true);
    expect(tableApplies("links", "harmonize_results")).toBe(true);
  });

  it("offers only header columns the server can address: no blank names, and a repeated name once (its last column)", () => {
    const cols = headerColumns(["", "name", "id", "id"]);
    expect(cols.map((c) => c.display)).toEqual(["(unnamed column 1)", "name", "id (column 3)", "id"]);
    expect(cols.filter((c) => c.usable).map((c) => c.name)).toEqual(["name", "id"]);
    expect(cols[3].index).toBe(3);
    expect(headerProblems(["", "name", "id", "id"])).toEqual([
      "Column 1 has no name, so it cannot be chosen.",
      "'id' names 2 columns. biomapper reads only the last of them (column 4).",
    ]);
    expect(headerProblems(["name", "hmdb"])).toEqual([]);
  });
});
