import { describe, expect, it } from "vitest";
import {
  STATE_LABELS,
  apiErrorMessage,
  canCancel,
  canResume,
  cleanVocabularies,
  describeItem,
  exportUrl,
  filenameFromDisposition,
  guessKeyColumn,
  guessNameColumn,
  guessVocabularies,
  hasResults,
  labelFromFilename,
  oversizeMessage,
  progressView,
  skippedFromHeader,
  stateLabel,
} from "./harmonize";
import type { HarmonizeItem } from "@workspace/api-client-react";

describe("run states", () => {
  it("has words for every state the package and the app report", () => {
    for (const s of ["queued", "running", "complete", "partial", "stalled", "paused", "expired", "cancelled", "failed", "owned_elsewhere", "unknown"]) {
      expect(STATE_LABELS[s]).toBeTruthy();
      expect(stateLabel(s)).not.toMatch(/undefined/);
    }
  });
  it("never shows a blank state", () => {
    expect(stateLabel(undefined)).toBe("Unknown");
    expect(stateLabel("")).toBe("Unknown");
    expect(stateLabel("new_state")).toBe("new state");
  });
  it("offers results only on complete and partial runs", () => {
    expect(hasResults("complete")).toBe(true);
    expect(hasResults("partial")).toBe(true);
    expect(hasResults("running")).toBe(false);
    expect(hasResults("cancelled")).toBe(false);
  });
  it("offers cancel and resume where the runner accepts them, never on finished-jobs runs", () => {
    expect(canCancel({ state: "running", kind: "harmonize_cohorts" })).toBe(true);
    expect(canCancel({ state: "complete", kind: "harmonize_cohorts" })).toBe(false);
    expect(canResume({ state: "cancelled", kind: "harmonize_many" })).toBe(true);
    expect(canResume({ state: "expired", kind: "harmonize_many" })).toBe(true);
    expect(canResume({ state: "failed", kind: "harmonize_many" })).toBe(false);
    expect(canResume({ state: "cancelled", kind: "harmonize_results" })).toBe(false);
    expect(canCancel({ state: "running", kind: "harmonize_results" })).toBe(false);
  });
});

describe("progressView", () => {
  it("shows the arm's own count, never above 100 percent", () => {
    const p = progressView({ function: "harmonize_cohorts", arm: "identifier", entitiesDone: 12, entitiesTotal: 30 });
    expect(p).toMatchObject({ armLabel: "Identifier", done: 12, total: 30, percent: 40, text: "12 of 30 entities" });
    const over = progressView({ function: "f", arm: "names_only", entitiesDone: 107, entitiesTotal: 53 });
    expect(over?.percent).toBe(100);
    expect(over?.done).toBe(53);
  });
  it("handles a zero total and a missing progress", () => {
    expect(progressView({ function: "f", arm: "review", entitiesDone: 0, entitiesTotal: 0 })?.percent).toBe(0);
    expect(progressView(null)).toBeNull();
  });
});

describe("apiErrorMessage", () => {
  it("returns the API's detail as written", () => {
    const msg = "Cohort labels must be distinct (got a, a).";
    expect(apiErrorMessage({ data: { detail: msg }, message: `HTTP 400 Bad Request: ${msg}` })).toBe(msg);
  });
  it("reads a validation list and strips the client prefix otherwise", () => {
    expect(apiErrorMessage({ data: { detail: [{ loc: ["body", "jobA"], msg: "Field required" }] } })).toBe("body.jobA: Field required");
    expect(apiErrorMessage(new Error("HTTP 502 Bad Gateway: upstream down"))).toBe("upstream down");
    expect(apiErrorMessage(null)).toBe("Something went wrong.");
  });
});

describe("cohort setup helpers", () => {
  it("builds a label the cohort rule accepts", () => {
    expect(labelFromFilename("My cohort (v2).tsv")).toBe("My_cohort_v2");
    expect(labelFromFilename("a.tsv")).toBe("a");
    expect(labelFromFilename("???.csv")).toBe("cohort");
  });
  it("writes the package's oversize message", () => {
    expect(oversizeMessage("a.tsv")).toBe("'a.tsv' is larger than the 50 MB limit.");
  });
  it("guesses name, key and vocabulary columns from the header", () => {
    const cols = ["id", "Analyte Name", "hmdb", "KEGG_ID", "notes"];
    expect(guessNameColumn(cols)).toBe("Analyte Name");
    expect(guessNameColumn(["x", "name"])).toBe("name");
    expect(guessKeyColumn(cols)).toBe("id");
    expect(guessKeyColumn(["a", "b"])).toBeNull();
    expect(guessVocabularies(cols, ["HMDB", "KEGG"])).toEqual({ HMDB: ["hmdb"], KEGG: ["KEGG_ID"] });
  });
  it("drops empty vocabularies", () => {
    expect(cleanVocabularies({ HMDB: ["h1", "h2"], " ": ["x"], KEGG: [] })).toEqual({ HMDB: ["h1", "h2"] });
  });
});

describe("describeItem", () => {
  const base = { members: [{ cohort: "a", key: "a1", name: "Glucose", chosenKgId: null }, { cohort: "b", key: "b1", name: "D-Glucose", chosenKgId: null }] };
  it("tells one-to-one links from ambiguous ones, with basis and partners", () => {
    const one = describeItem({ ...base, kind: "link", detail: { basis: "node", ambiguous: false, aPartners: 1, bPartners: 1 } } as Pick<HarmonizeItem, "kind" | "detail" | "members">);
    expect(one.title).toBe("One-to-one link");
    expect(one.facts).toContain("Basis: Same node");
    const amb = describeItem({ ...base, kind: "link", detail: { basis: "name_casefold", ambiguous: true, aPartners: 1, bPartners: 2 } } as Pick<HarmonizeItem, "kind" | "detail" | "members">);
    expect(amb.title).toBe("Ambiguous link");
    expect(amb.facts).toContain("Partners: A 1, B 2");
  });
  it("describes groups, review entries and unresolved rows", () => {
    expect(describeItem({ ...base, kind: "group", detail: { multiplicity: true, cohorts: ["a", "b"], node: "RM:1" } } as never).title).toBe("Group with multiplicity");
    expect(describeItem({ ...base, kind: "review", detail: { origin: "cross_node", nodeA: "RM:1", nodeB: "RM:2", nRowPairs: 4 } } as never).facts).toEqual(["RM:1 and RM:2", "4 row pairs"]);
    expect(describeItem({ ...base, kind: "review", detail: { origin: "review_queue", vocabulary: "KEGG", code: "C00031", status: "disagree" } } as never).title).toBe("One-sided identifier check");
    expect(describeItem({ ...base, kind: "unresolved", detail: { bucket: "errored", error: "timeout" } } as never)).toMatchObject({ title: "Errored row", facts: ["timeout"] });
  });
});

describe("exports", () => {
  it("builds the export URL", () => {
    expect(exportUrl("abc", "eitl_pairs", "json")).toBe("/api/harmonize/runs/abc/export?table=eitl_pairs&format=json");
  });
  it("reads the file name and the skipped count from the headers", () => {
    expect(filenameFromDisposition('attachment; filename="harmonize_cohorts_a_b_links.csv"', "x")).toBe("harmonize_cohorts_a_b_links.csv");
    expect(filenameFromDisposition("attachment; filename*=UTF-8''r%20s.json", "x")).toBe("r s.json");
    expect(filenameFromDisposition(null, "fallback.csv")).toBe("fallback.csv");
    expect(skippedFromHeader("1")).toBe(1);
    expect(skippedFromHeader("0")).toBe(0);
    expect(skippedFromHeader(null)).toBeNull();
    expect(skippedFromHeader("x")).toBeNull();
  });
});
