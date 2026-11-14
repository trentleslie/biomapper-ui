import { useEffect, useMemo, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Download, Info, Loader2 } from "lucide-react";
import {
  getGetHarmonizeReportQueryKey,
  getGetHarmonizeRunQueryKey,
  getListHarmonizeItemsQueryKey,
  getListHarmonizeRunsQueryKey,
  useGetHarmonizeReport,
  useGetHarmonizeRun,
  useListHarmonizeRuns,
  type HarmonizeArm,
  type HarmonizeItem,
  type HarmonizeItemKind,
  type HarmonizeItemsPage,
  type HarmonizeRunStatus,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { apiErrorMessage, errorStatus, hasResults, isActive } from "@/lib/harmonize";
import { isMany, type Report } from "@/lib/harmonize-report";
import { ErrorBox, SkeletonRows } from "@/components/harmonize/primitives";
import { NoRunSelected, ProgressPanel, RunHeader, RunList } from "@/components/harmonize/run-panels";
import { SetupSheet, useStartExample, type SetupTab } from "@/components/harmonize/SetupSheet";
import { ItemsView, NO_FILTERS, type ItemFilters } from "@/components/harmonize/ItemsView";
import { ItemPanel, ReviewItemPanel, ReviewQueueView } from "@/components/harmonize/DetailPanels";
import { ArmStrip, ExportPanel, RunDetailsPanel } from "@/components/harmonize/ReportPanels";

const LAST_RUN_KEY = "harmonize:last-run";

function rememberRun(jobId: string) {
  try {
    window.localStorage.setItem(LAST_RUN_KEY, jobId);
  } catch {
    /* storage unavailable: nothing to remember */
  }
}

function lastRun(): string | null {
  try {
    return window.localStorage.getItem(LAST_RUN_KEY);
  } catch {
    return null;
  }
}

type DockState =
  | { kind: "none" }
  | { kind: "item"; item: HarmonizeItem }
  | { kind: "review"; ref: string }
  | { kind: "details" }
  | { kind: "export" };

// ---------------------------------------------------------------------------
// The finished run: the table is the page, everything else docks beside it
// ---------------------------------------------------------------------------

function ResultsWorkbench({ run, dock, setDock }: { run: HarmonizeRunStatus; dock: DockState; setDock: (d: DockState) => void }) {
  const queryClient = useQueryClient();
  const report = useGetHarmonizeReport(run.jobId, { query: { queryKey: getGetHarmonizeReportQueryKey(run.jobId), staleTime: Infinity } });
  const [view, setView] = useState<"items" | "review">("items");
  const [filters, setFilters] = useState<ItemFilters>(NO_FILTERS);
  const [pageItems, setPageItems] = useState<HarmonizeItem[]>([]);

  useEffect(() => {
    setView("items");
    setFilters(NO_FILTERS);
  }, [run.jobId]);

  const data = report.data as Report | undefined;
  const many = data ? isMany(data) : run.kind === "harmonize_many";
  const kinds: HarmonizeItemKind[] = many ? ["group", "review", "unresolved"] : ["link", "review", "unresolved"];
  const armsAvailable: HarmonizeArm[] = data && (data.arms as Record<string, unknown> | undefined)?.identifier ? ["names_only", "identifier"] : ["names_only"];

  // The flagged total of the run, from whichever items page is cached most recently.
  const flaggedTotal = useMemo(() => {
    const pages = queryClient.getQueriesData<HarmonizeItemsPage>({ queryKey: getListHarmonizeItemsQueryKey(run.jobId) });
    for (const [, page] of pages) if (page) return page.flaggedTotal;
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageItems, queryClient, run.jobId]);

  // Keep the open item in step with the table after a flag change made in either place.
  useEffect(() => {
    if (dock.kind !== "item") return;
    const fresh = pageItems.find((i) => i.ref === dock.item.ref);
    if (fresh && (fresh.flagged !== dock.item.flagged || fresh.source !== dock.item.source)) setDock({ kind: "item", item: fresh });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageItems]);

  const openIndex = dock.kind === "item" ? pageItems.findIndex((i) => i.ref === dock.item.ref) : -1;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {report.isLoading ? (
        <div className="h-16 animate-pulse rounded border border-neutral-200 bg-neutral-50" aria-label="Loading the report" />
      ) : report.isError ? (
        <ErrorBox title="Could not load the run's report" message={apiErrorMessage(report.error)} onRetry={() => void report.refetch()} />
      ) : data ? (
        <ArmStrip report={data} onOpenDetails={() => setDock({ kind: "details" })} />
      ) : null}

      <div className="flex min-h-0 flex-1 gap-2">
        <section aria-label="Workbench" className="flex min-w-0 flex-1 flex-col rounded border border-neutral-200 bg-white">
          <div role="tablist" aria-label="Workbench view" className="flex gap-1 border-b border-neutral-200 px-2 pt-1.5">
            {(
              [
                ["items", "Items to review and flag"],
                ["review", "Review queue evidence"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={view === value}
                onClick={() => setView(value)}
                className={cn(
                  "-mb-px rounded-t border-b-2 px-3 py-1.5 text-sm",
                  view === value ? "border-ph-navy font-semibold text-neutral-900" : "border-transparent text-neutral-600 hover:text-neutral-900",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {view === "items" ? (
            <ItemsView
              jobId={run.jobId}
              kinds={kinds}
              armsAvailable={armsAvailable}
              filters={filters}
              setFilters={setFilters}
              selectedRef={dock.kind === "item" ? dock.item.ref : null}
              onOpen={(item) => setDock({ kind: "item", item })}
              onItemsChanged={setPageItems}
            />
          ) : (
            <ReviewQueueView
              jobId={run.jobId}
              available={run.kind !== "harmonize_results"}
              selectedRef={dock.kind === "review" ? dock.ref : null}
              onOpen={(ref) => setDock({ kind: "review", ref })}
            />
          )}
        </section>

        {dock.kind === "item" && (
          <ItemPanel
            key={dock.item.ref}
            jobId={run.jobId}
            item={dock.item}
            onItemChange={(item) => setDock({ kind: "item", item })}
            position={openIndex >= 0 ? `${openIndex + 1} of ${pageItems.length} on this page` : null}
            onPrev={openIndex > 0 ? () => setDock({ kind: "item", item: pageItems[openIndex - 1] }) : null}
            onNext={openIndex >= 0 && openIndex < pageItems.length - 1 ? () => setDock({ kind: "item", item: pageItems[openIndex + 1] }) : null}
            onClose={() => setDock({ kind: "none" })}
          />
        )}
        {dock.kind === "review" && <ReviewItemPanel key={dock.ref} jobId={run.jobId} refId={dock.ref} onClose={() => setDock({ kind: "none" })} />}
        {dock.kind === "details" && data && <RunDetailsPanel run={run} report={data} onClose={() => setDock({ kind: "none" })} />}
        {dock.kind === "export" && <ExportPanel run={run} many={many} flaggedTotal={flaggedTotal} onClose={() => setDock({ kind: "none" })} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export default function HarmonizePage() {
  const [, params] = useRoute("/harmonize/:jobId");
  const routeJobId = params?.jobId ?? null;
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupTab, setSetupTab] = useState<SetupTab>("files");
  const [dock, setDock] = useState<DockState>({ kind: "none" });

  const runs = useListHarmonizeRuns({
    query: {
      queryKey: getListHarmonizeRunsQueryKey(),
      refetchInterval: (q) => ((q.state.data ?? []).some((r) => isActive(r.state)) ? 3000 : false),
    },
  });

  // With no run in the address, open the last one viewed, else the newest. A returning user lands on results.
  useEffect(() => {
    if (routeJobId || !runs.data || runs.data.length === 0) return;
    const remembered = lastRun();
    const target = runs.data.find((r) => r.jobId === remembered) ?? runs.data[0];
    setLocation(`/harmonize/${target.jobId}`, { replace: true });
  }, [routeJobId, runs.data, setLocation]);

  useEffect(() => {
    if (routeJobId) rememberRun(routeJobId);
    setDock({ kind: "none" });
  }, [routeJobId]);

  const run = useGetHarmonizeRun(routeJobId ?? "", {
    query: {
      queryKey: getGetHarmonizeRunQueryKey(routeJobId ?? ""),
      enabled: !!routeJobId,
      refetchInterval: (q) => (isActive(q.state.data?.state) ? 1500 : false),
      retry: (count, err) => errorStatus(err) !== 404 && count < 2,
    },
  });

  // When the open run finishes, refresh the list so its state there matches.
  const state = run.data?.state;
  useEffect(() => {
    if (state && !isActive(state)) void queryClient.invalidateQueries({ queryKey: getListHarmonizeRunsQueryKey() });
  }, [state, queryClient]);

  const onStarted = (started: HarmonizeRunStatus) => {
    setSetupOpen(false);
    queryClient.setQueryData(getGetHarmonizeRunQueryKey(started.jobId), started);
    void queryClient.invalidateQueries({ queryKey: getListHarmonizeRunsQueryKey() });
    setLocation(`/harmonize/${started.jobId}`);
  };
  const example = useStartExample(onStarted);

  // The open run's live status wins over the list's copy.
  const listed = useMemo(() => {
    if (!runs.data) return runs.data;
    return runs.data.map((r) => (run.data && r.jobId === run.data.jobId ? { ...r, ...run.data } : r));
  }, [runs.data, run.data]);

  const openSetup = (tab: SetupTab = "files") => {
    setSetupTab(tab);
    setSetupOpen(true);
  };

  let body: React.ReactNode;
  if (!routeJobId) {
    body = runs.isLoading ? (
      <div className="flex-1 rounded border border-neutral-200 bg-white">
        <SkeletonRows rows={8} />
      </div>
    ) : (
      <NoRunSelected onNewRun={() => openSetup("files")} onExample={(k) => void example.start(k)} />
    );
  } else if (run.isLoading) {
    body = (
      <div className="flex-1 rounded border border-neutral-200 bg-white">
        <SkeletonRows rows={8} />
      </div>
    );
  } else if (run.isError || !run.data) {
    body = (
      <ErrorBox
        title={errorStatus(run.error) === 404 ? "This run was not found" : "Could not load this run"}
        message={errorStatus(run.error) === 404 ? "It may belong to another account, or the link is wrong. Choose a run from the list." : apiErrorMessage(run.error)}
        onRetry={errorStatus(run.error) === 404 ? undefined : () => void run.refetch()}
      />
    );
  } else {
    const r = run.data;
    body = (
      <>
        <RunHeader
          run={r}
          actions={
            <>
              <Button variant={dock.kind === "details" ? "default" : "secondary"} size="sm" aria-pressed={dock.kind === "details"} onClick={() => setDock(dock.kind === "details" ? { kind: "none" } : { kind: "details" })}>
                <Info aria-hidden /> Run details
              </Button>
              <Button variant={dock.kind === "export" ? "default" : "secondary"} size="sm" aria-pressed={dock.kind === "export"} onClick={() => setDock(dock.kind === "export" ? { kind: "none" } : { kind: "export" })}>
                <Download aria-hidden /> Export
              </Button>
            </>
          }
        />
        {hasResults(r.state) ? <ResultsWorkbench run={r} dock={dock} setDock={setDock} /> : <ProgressPanel run={r} />}
      </>
    );
  }

  return (
    <div className="-mx-2 -my-4 flex h-[calc(100dvh-2rem)] min-h-[560px] gap-3 lg:-mx-4" data-testid="harmonize-page">
      <RunList
        runs={listed}
        isLoading={runs.isLoading}
        error={runs.error}
        onRetry={() => void runs.refetch()}
        selectedId={routeJobId}
        onNewRun={() => openSetup("files")}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {(example.busy || example.error) && (
          <div aria-live="polite">
            {example.busy && (
              <p className="flex items-center gap-2 rounded border border-info-border bg-info-bg px-3 py-2 text-sm text-info">
                <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> Starting the example
              </p>
            )}
            {example.error && <ErrorBox title="The example did not start" message={example.error} />}
          </div>
        )}
        {body}
      </div>
      <SetupSheet open={setupOpen} onOpenChange={setSetupOpen} tab={setupTab} onTabChange={setSetupTab} onStarted={onStarted} />
    </div>
  );
}
