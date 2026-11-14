import { useEffect, useRef, useState } from "react";
import { useLocation, useRoute } from "wouter";
import {
  useListHarmonizeRuns,
  getListHarmonizeRunsQueryKey,
  useGetHarmonizeRun,
  getGetHarmonizeRunQueryKey,
  type HarmonizeRunStatus,
} from "@workspace/api-client-react";
import { ArrowDown, Workflow } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { HarmonizeSetup, type SetupMode } from "@/components/harmonize/HarmonizeSetup";
import { RunsList } from "@/components/harmonize/RunsList";
import { RunPanel } from "@/components/harmonize/RunPanel";
import { EmptyState, Notice, StateBadge } from "@/components/harmonize/common";
import { armLabel, armProgress, isWaiting, pollInterval } from "@/lib/harmonize";

const LAST_RUN_KEY = "biomapper.harmonize.lastRun";

function readLastRun(): string | null {
  try {
    return window.localStorage.getItem(LAST_RUN_KEY);
  } catch {
    return null;
  }
}

function writeLastRun(jobId: string | null) {
  try {
    if (jobId) window.localStorage.setItem(LAST_RUN_KEY, jobId);
    else window.localStorage.removeItem(LAST_RUN_KEY);
  } catch {
    /* private window: the runs list still finds the run */
  }
}

/**
 * Harmonization on one page, like entity resolution's upload and dashboard: setup at the top, the run and every
 * result below it, scrolling from inputs to exports. The open run lives in the URL (/harmonize/<jobId>), so a
 * reload, a shared link or coming back from another page lands on the same run.
 */
export default function HarmonizePage() {
  const [, setLocation] = useLocation();
  const [, params] = useRoute("/harmonize/:jobId");
  const jobId = params?.jobId ?? null;
  const [mode, setMode] = useState<SetupMode>("two");
  const runSection = useRef<HTMLElement>(null);
  const scrollOnOpen = useRef(false);

  const runs = useListHarmonizeRuns({ query: { queryKey: getListHarmonizeRunsQueryKey(), retry: 1 } });

  // Coming back to /harmonize reopens the run that was open last, if it is still listed.
  useEffect(() => {
    if (jobId || !runs.data) return;
    const last = readLastRun();
    if (last && runs.data.some((r) => r.jobId === last)) setLocation(`/harmonize/${last}`, { replace: true });
  }, [jobId, runs.data, setLocation]);

  useEffect(() => {
    if (jobId) writeLastRun(jobId);
    if (jobId && scrollOnOpen.current) {
      scrollOnOpen.current = false;
      // Let the run panel render first, then bring it into view.
      requestAnimationFrame(() => runSection.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  }, [jobId]);

  const openRun = (id: string) => {
    scrollOnOpen.current = true;
    setLocation(`/harmonize/${id}`);
  };
  const onStarted = (run: HarmonizeRunStatus) => openRun(run.jobId);

  const active = (runs.data ?? []).find((r) => isWaiting(r.state) && r.jobId !== jobId);
  // The same query (and cache entry) the run panel polls, so the two never disagree.
  const shownRun = useGetHarmonizeRun(jobId ?? "", {
    query: {
      queryKey: getGetHarmonizeRunQueryKey(jobId ?? ""),
      enabled: !!jobId,
      retry: false,
      refetchInterval: (q) => pollInterval(q.state.data?.state),
    },
  }).data;
  const pillProgress = armProgress(shownRun?.progress);

  return (
    <>
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">Harmonize cohorts</h1>
          <p className="mt-1 max-w-3xl text-sm text-neutral-500">
            Find which rows in two or more datasets are the same entity, flag what an expert should check, and download
            the result for expert review.
          </p>
        </div>
        {jobId && shownRun && (
          <div className="flex items-center gap-3 rounded border border-neutral-200 bg-white px-3 py-2" data-testid="open-run-pill">
            <div className="min-w-0 text-sm">
              <p className="text-xs text-neutral-500">Open run</p>
              <p className="max-w-[22rem] truncate font-medium text-neutral-900" title={(shownRun.labels ?? []).join(", ")}>
                {(shownRun.labels ?? []).join(", ") || "Unlabelled cohorts"}
              </p>
            </div>
            <StateBadge state={shownRun.state} />
            {isWaiting(shownRun.state) && pillProgress && (
              <span className="text-xs tabular-nums text-neutral-600" data-testid="open-run-progress">
                {armLabel(pillProgress.arm)}: {pillProgress.done} of {pillProgress.total}
              </span>
            )}
            <Button size="sm" variant="secondary" onClick={() => runSection.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
              <ArrowDown /> Go to run
            </Button>
          </div>
        )}
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
        <HarmonizeSetup mode={mode} onModeChange={setMode} onStarted={onStarted} />
        <aside className="lg:sticky lg:top-0" aria-label="Your runs">
          <RunsList selected={jobId} onSelect={openRun} />
        </aside>
      </div>

      {/* At least a window tall, so bringing the run into view always works, even before its results load. */}
      <section ref={runSection} aria-labelledby="run-heading" className="mt-10 min-h-[85dvh] scroll-mt-6" data-testid="run-section">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 id="run-heading" className="text-lg font-semibold tracking-tight text-neutral-900">Run and results</h2>
          {jobId && (
            <Button variant="ghost" size="sm" onClick={() => { writeLastRun(null); setLocation("/harmonize"); }}>
              Close this run
            </Button>
          )}
        </div>
        {active && (
          <Notice
            tone="info"
            className="mb-4"
            testId="active-run-notice"
            action={<Button size="sm" variant="secondary" onClick={() => openRun(active.jobId)}>Open the running run</Button>}
          >
            A run is {active.state} for {(active.labels ?? []).join(", ") || "your cohorts"}.
          </Notice>
        )}
        {jobId ? (
          <RunPanel key={jobId} jobId={jobId} />
        ) : (
          <Card>
            <CardContent>
              <EmptyState
                icon={Workflow}
                title="No run open"
                description="Start a run above, or open one from Your runs. Its progress, results, flags and downloads appear here."
              />
            </CardContent>
          </Card>
        )}
      </section>
    </>
  );
}
