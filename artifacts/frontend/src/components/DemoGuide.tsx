import { useState } from "react";
import { ChevronDown, ChevronRight, BookOpen } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EXPLAINERS, TIER_HIGH_MIN, TIER_MEDIUM_MIN } from "@/lib/result-explainers";

// Walkthrough shown on the demo dashboard: what happened, how to read each column, and what the
// numbers do and do not mean. Open by default so a presenter can talk through it.

function Row({ term, children }: { term: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[10rem_1fr] gap-1 sm:gap-4 py-2 border-b last:border-0">
      <dt className="text-sm font-medium text-neutral-900">{term}</dt>
      <dd className="text-sm text-neutral-600">{children}</dd>
    </div>
  );
}

export function DemoGuide() {
  const [open, setOpen] = useState(true);

  return (
    <Card className="mb-6 border-ph-navy/20" data-testid="demo-guide">
      <CardHeader className="pb-2">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex items-center gap-2 text-left w-full"
        >
          {open ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
          <BookOpen className="w-5 h-5 text-ph-navy shrink-0" />
          <div>
            <CardTitle className="text-base">How to read these results</CardTitle>
            <CardDescription>What BioMapper did, and what each column means</CardDescription>
          </div>
        </button>
      </CardHeader>
      {open && (
        <CardContent className="space-y-6">
          <section>
            <h3 className="text-sm font-semibold text-neutral-900 mb-2">What just happened</h3>
            <ol className="list-decimal ml-5 space-y-1 text-sm text-neutral-600">
              <li>Each compound name was sent, on its own, to the live BioMapper service.</li>
              <li>
                BioMapper searched a biomedical knowledge graph for matching concepts, preferring the
                standard metabolite databases (ChEBI, HMDB, RefMet), and checked curated sources such as
                RefMet and LIPID MAPS.
              </li>
              <li>
                It picked one identifier per name and gathered the cross-references for that compound in
                other databases.
              </li>
              <li>Rows that deserve a second look are collected under Needs Review.</li>
            </ol>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-neutral-900 mb-1">Columns</h3>
            <dl>
              <Row term="Name">{EXPLAINERS.name}</Row>
              <Row term="Primary Curie">{EXPLAINERS.primaryCurie}</Row>
              <Row term="Score">{EXPLAINERS.score}</Row>
              <Row term="Tier">
                <div className="flex flex-wrap gap-1.5 mb-1.5">
                  <Badge variant="success">high &ge; {TIER_HIGH_MIN.toFixed(1)}</Badge>
                  <Badge variant="warning">medium {TIER_MEDIUM_MIN.toFixed(1)} to {TIER_HIGH_MIN.toFixed(1)}</Badge>
                  <Badge variant="danger">low &lt; {TIER_MEDIUM_MIN.toFixed(1)}</Badge>
                  <Badge variant="neutral">unknown: no score</Badge>
                  <Badge variant="neutral">unresolved: no match</Badge>
                </div>
                {EXPLAINERS.tier}
              </Row>
              <Row term="Database columns">{EXPLAINERS.vocabColumns}</Row>
              <Row term="Needs Review">{EXPLAINERS.needsReview}</Row>
            </dl>
          </section>

          <section className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3">
            <h3 className="text-sm font-semibold text-neutral-900 mb-1">What this demo does and does not show</h3>
            <ul className="list-disc ml-5 space-y-1 text-sm text-neutral-700">
              <li>
                It shows the workflow: raw names in, standardized identifiers and cross-references out, with
                uncertain rows surfaced for review.
              </li>
              <li>
                It is not an accuracy test. The sample names are illustrative and no answer key is compared
                against the output. Accuracy is measured separately, against curated reference sets.
              </li>
              <li>
                A High tier means a strong text match in the search, not a verified answer. BioMapper picks the
                identifier by database preference and exact name match, not by score alone.
              </li>
              <li>Results come from the live service, so scores can vary slightly between runs.</li>
            </ul>
          </section>
        </CardContent>
      )}
    </Card>
  );
}
