import { Link, useLocation, useSearch } from "wouter";
import { ArrowRight } from "lucide-react";
import { getGetHarmonizeReportQueryKey, useGetHarmonizeReport, type HarmonizeRunStatus } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { errorMessage, plural, type Json } from "@/lib/harmonize";
import { ErrorPanel, LoadingBlock } from "./common";
import { FlagItemsView } from "./FlagItems";
import { ArmResultsView, ReviewQueueView, SummaryView } from "./ReviewSummary";
import { stageHref } from "./StageRail";

const VIEWS = [
  { id: "summary", label: "Summary" },
  { id: "results", label: "Results by arm" },
  { id: "flags", label: "Flag items" },
  { id: "queue", label: "Review queue" },
] as const;
type View = (typeof VIEWS)[number]["id"];

/** Review and flag: the report in readable parts, and the flagging list. The chosen view is kept in the URL. */
export function ReviewStage({ run, flaggedTotal }: { run: HarmonizeRunStatus; flaggedTotal: number | null }) {
  const search = useSearch();
  const [location, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const requested = params.get("view");
  const view: View = VIEWS.some((v) => v.id === requested) ? (requested as View) : "summary";
  const setView = (v: string) => {
    const next = new URLSearchParams(search);
    next.set("view", v);
    navigate(`${location}?${next.toString()}`, { replace: true });
  };

  const reportQuery = useGetHarmonizeReport(run.jobId, {
    query: { queryKey: getGetHarmonizeReportQueryKey(run.jobId), staleTime: Infinity, retry: 1 },
  });
  const report = reportQuery.data as unknown as Json | undefined;

  return (
    <div className="space-y-6">
      <Tabs value={view} onValueChange={setView}>
        <TabsList aria-label="Review views" className="h-auto flex-wrap justify-start">
          {VIEWS.map((v) => (
            <TabsTrigger key={v.id} value={v.id}>
              {v.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {view === "flags" ? (
          <TabsContent value="flags" className="mt-4">
            <FlagItemsView jobId={run.jobId} kind={run.kind} />
          </TabsContent>
        ) : reportQuery.isLoading ? (
          <div className="mt-4">
            <LoadingBlock lines={5} label="Loading the report" />
          </div>
        ) : reportQuery.isError || !report ? (
          <div className="mt-4">
            <ErrorPanel title="The report did not load" message={errorMessage(reportQuery.error)} onRetry={() => reportQuery.refetch()} />
          </div>
        ) : (
          <>
            <TabsContent value="summary" className="mt-4">
              <SummaryView report={report} run={run} />
            </TabsContent>
            <TabsContent value="results" className="mt-4">
              <ArmResultsView report={report} kind={run.kind} />
            </TabsContent>
            <TabsContent value="queue" className="mt-4">
              <ReviewQueueView report={report} run={run} />
            </TabsContent>
          </>
        )}
      </Tabs>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-neutral-200 bg-neutral-50 px-5 py-4">
        <p className="text-sm text-neutral-700">
          {flaggedTotal == null ? "Flag what an expert should check, then export." : `${plural(flaggedTotal, "item")} flagged for expert review.`}
          {view !== "flags" && (
            <Button variant="link" className="ml-2" onClick={() => setView("flags")}>
              Change flags
            </Button>
          )}
        </p>
        <Button asChild size="lg">
          <Link href={stageHref(run.jobId, "export")}>
            Continue to export <ArrowRight aria-hidden />
          </Link>
        </Button>
      </div>
    </div>
  );
}
