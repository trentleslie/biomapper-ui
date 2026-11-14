import { useEffect, useRef, type ReactNode } from "react";
import { Link, useRoute } from "wouter";
import { ArrowLeft, Plus } from "lucide-react";
import {
  getGetHarmonizeReportQueryKey,
  getGetHarmonizeRunQueryKey,
  getListHarmonizeItemsQueryKey,
  useGetHarmonizeReport,
  useGetHarmonizeRun,
  useListHarmonizeItems,
  useListHarmonizeRuns,
  getListHarmonizeRunsQueryKey,
  type HarmonizeRunStatus,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { DataTable, ErrorPanel, LoadingBlock, Mono, Note, Panel, StateBadge } from "@/components/harmonize/common";
import { ExportStage } from "@/components/harmonize/ExportStage";
import { ReviewStage } from "@/components/harmonize/ReviewStage";
import { RunsList } from "@/components/harmonize/RunsList";
import { RunStage } from "@/components/harmonize/RunStage";
import { SetupStage } from "@/components/harmonize/SetupStage";
import { StageRail, stageHref } from "@/components/harmonize/StageRail";
import {
  STAGE_TITLE,
  asObject,
  defaultStage,
  errorMessage,
  errorStatus,
  formatWhen,
  hasResults,
  isActive,
  isStage,
  kindLabel,
  nameLinking,
  stageReachable,
  type Json,
  type Stage,
} from "@/lib/harmonize";

function PageHeader({ run }: { run: HarmonizeRunStatus | null }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">Harmonize cohorts</h1>
        <p className="mt-1 max-w-2xl text-sm text-neutral-500">
          Find the rows that are the same entity across your datasets, flag what an expert should check, and export the
          pairs for expert review.
        </p>
      </div>
      {run && (
        <Button asChild variant="secondary">
          <Link href="/harmonize">
            <Plus aria-hidden /> Start a new run
          </Link>
        </Button>
      )}
    </div>
  );
}

/** Who and what this run is, shown above every stage of an open run. */
function RunIdentity({ run }: { run: HarmonizeRunStatus }) {
  return (
    <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded border border-neutral-200 bg-neutral-50 px-4 py-3" data-testid="run-identity">
      <p className="min-w-0 text-sm font-semibold text-neutral-900">{run.labels.join(", ") || "Unlabelled run"}</p>
      <span className="text-sm text-neutral-600">{kindLabel(run.kind)}</span>
      <span className="text-sm text-neutral-600">
        Entity: <span className="text-neutral-900">{run.entity || "Not recorded"}</span>
      </span>
      <span className="text-sm text-neutral-600">Started {formatWhen(run.createdAt)}</span>
      <StateBadge state={run.state} className="ml-auto" />
    </div>
  );
}

/** Stage 1 for a run that exists: what it was set up with, read only. */
function RunSetupSummary({ run }: { run: HarmonizeRunStatus }) {
  const finished = hasResults(run.state);
  const reportQuery = useGetHarmonizeReport(run.jobId, {
    query: { queryKey: getGetHarmonizeReportQueryKey(run.jobId), enabled: finished, staleTime: Infinity, retry: 1 },
  });
  const report = reportQuery.data as unknown as Json | undefined;
  const settings = asObject(report?.settings);
  const cohortSettings = asObject(settings?.cohorts);
  const nl = nameLinking(report);
  const rows = (run.cohorts ?? run.labels.map((label) => ({ label, rows: null as number | null }))).map((c) => {
    const s = asObject(cohortSettings?.[c.label]);
    const vocab = asObject(s?.vocabularies);
    const source = asObject(s?.source);
    return [
      c.label,
      typeof c.rows === "number" ? c.rows.toLocaleString() : "Not reported",
      source?.file ? <Mono key="f">{String(source.file)}</Mono> : "Not reported",
      s?.name_column ? <Mono key="n">{String(s.name_column)}</Mono> : "Not reported",
      s?.key_column ? <Mono key="k">{String(s.key_column)}</Mono> : s ? "None" : "Not reported",
      vocab && Object.keys(vocab).length
        ? Object.entries(vocab).map(([v, cols]) => `${v}: ${(cols as string[]).join(", ")}`).join("; ")
        : s
          ? "None"
          : "Not reported",
    ];
  });
  return (
    <div className="space-y-6">
      <Panel
        id="setup-summary"
        title="How this run was set up"
        description="A run's setup cannot change. To try other columns or files, start a new run."
        actions={
          <Button asChild>
            <Link href="/harmonize">
              <Plus aria-hidden /> Start a new run
            </Link>
          </Button>
        }
      >
        <div className="space-y-4">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-xs text-neutral-500">What was harmonized</dt>
              <dd className="text-neutral-900">{kindLabel(run.kind)}</dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500">Entity</dt>
              <dd className="text-neutral-900">{run.entity || "Not recorded"}</dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500">Category</dt>
              <dd className="text-neutral-900">
                {report ? String(report.category ?? settings?.category ?? "Not recorded") : finished ? "Loading" : "Shown when the run finishes"}
                {settings?.category_overridden === true && " (override)"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500">Name linking</dt>
              <dd className="text-neutral-900">{nl ? (nl.enabled ? "On" : "Off") : finished ? "Not recorded" : "Shown when the run finishes"}</dd>
            </div>
          </dl>
          {nl?.reason && <p className="text-sm text-neutral-600">{nl.reason}</p>}
          {reportQuery.isError && <p className="text-sm text-danger">{errorMessage(reportQuery.error)}</p>}
          <DataTable
            caption="Cohorts of this run"
            headers={["Label", "Rows", "File", "Name column", "Key column", "Identifier columns"]}
            rows={rows}
            empty="This run lists no cohorts."
          />
        </div>
      </Panel>
      <div className="flex justify-end">
        <Button asChild size="lg">
          <Link href={stageHref(run.jobId, finished ? "review" : "run")}>
            {finished ? "Go to results" : "Go to the run"}
          </Link>
        </Button>
      </div>
    </div>
  );
}

/** A 4xx answer will not change on a retry. */
function isClientError(err: unknown): boolean {
  const status = errorStatus(err);
  return status !== null && status >= 400 && status < 500;
}

function OpenRun({ jobId, requested }: { jobId: string; requested: string | undefined }) {
  const runQuery = useGetHarmonizeRun(jobId, {
    query: {
      queryKey: getGetHarmonizeRunQueryKey(jobId),
      retry: (count, err) => !isClientError(err) && count < 2,
      refetchInterval: (q) => {
        const state = q.state.data?.state;
        if (!state) return false;
        if (isActive(state)) return 2000;
        if (hasResults(state) || state === "cancelled" || state === "failed" || state === "unknown") return false;
        return 10_000;
      },
    },
  });
  // The runs list still lists a run the job runner lost (state unknown, with its reason), while its own route
  // answers 400. Such a run is shown from its list entry, with the later steps locked.
  const refused = runQuery.isError && !runQuery.data && isClientError(runQuery.error) && errorStatus(runQuery.error) !== 404;
  const runsQuery = useListHarmonizeRuns({ query: { queryKey: getListHarmonizeRunsQueryKey(), enabled: refused } });
  const listed = refused ? (runsQuery.data?.find((r) => r.jobId === jobId) ?? null) : null;
  const fromList: HarmonizeRunStatus | null = listed
    ? { ...listed, state: "unknown", reason: listed.reason ?? errorMessage(runQuery.error) }
    : null;
  const run = runQuery.data ?? fromList;
  const finished = hasResults(run?.state);
  const flaggedQuery = useListHarmonizeItems(jobId, { limit: 1 }, {
    query: { queryKey: getListHarmonizeItemsQueryKey(jobId, { limit: 1 }), enabled: finished },
  });
  const flaggedTotal = flaggedQuery.data?.flaggedTotal ?? null;

  let body;
  let stage: Stage = isStage(requested) ? requested : defaultStage(run?.state);
  if (runQuery.isLoading || (refused && runsQuery.isLoading)) {
    body = <LoadingBlock lines={5} label="Loading the run" />;
  } else if (!run) {
    const notFound = errorStatus(runQuery.error) === 404;
    body = (
      <div className="space-y-4">
        <ErrorPanel
          title={notFound ? "Run not found" : "The run did not load"}
          message={notFound ? "No run of yours has this id. It may belong to someone else, or the link is wrong." : errorMessage(runQuery.error)}
          onRetry={notFound || isClientError(runQuery.error) ? undefined : () => runQuery.refetch()}
        />
        <Button asChild variant="secondary">
          <Link href="/harmonize">
            <ArrowLeft aria-hidden /> Back to your runs
          </Link>
        </Button>
      </div>
    );
  } else {
    let notice = null;
    if (!stageReachable(stage, run.state)) {
      const noResults = run.state === "failed" || run.state === "unknown";
      notice = noResults ? (
        <Note tone="info" title={`${STAGE_TITLE[stage]} is not available for this run`} className="mb-4">
          {run.state === "failed"
            ? "The run failed, so it has no results to review or export. Its status is below."
            : "The job runner no longer knows this run, so it has no results to review or export. Its status is below."}
        </Note>
      ) : (
        <Note tone="info" title={`${STAGE_TITLE[stage]} opens when the run is complete`} className="mb-4">
          The run is {run.state === "running" ? "still running" : `${run.state.replace(/_/g, " ")}`}. Its progress is below.
        </Note>
      );
      stage = "run";
    }
    body = (
      <>
        <RunIdentity run={run} />
        {runQuery.isError && runQuery.data && (
          <p role="status" className="mb-4 text-sm text-warning" data-testid="refresh-failed">
            Could not refresh the run ({errorMessage(runQuery.error)}). Showing the last state received; it will try again.
          </p>
        )}
        {notice}
        {stage === "setup" && <RunSetupSummary run={run} />}
        {stage === "run" && <RunStage run={run} />}
        {stage === "review" && <ReviewStage run={run} flaggedTotal={flaggedTotal} />}
        {stage === "export" && <ExportStage run={run} flaggedTotal={flaggedTotal} />}
      </>
    );
  }

  // A stage change unmounts the link that was focused and leaves the page scrolled down: start the new stage at
  // the top, with focus on its heading so keyboard and screen reader users land in it.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shownStage = useRef<Stage | null>(null);
  const ready = !!run;
  useEffect(() => {
    if (!ready) return;
    if (shownStage.current !== null && shownStage.current !== stage) {
      headingRef.current?.closest("main")?.scrollTo({ top: 0 });
      headingRef.current?.focus({ preventScroll: true });
    }
    shownStage.current = stage;
  }, [stage, ready]);

  return (
    <>
      <PageHeader run={run} />
      <FlowLayout rail={<StageRail jobId={run ? jobId : null} current={stage} run={run} flaggedTotal={flaggedTotal} />}>
        <h2 ref={headingRef} tabIndex={-1} className="sr-only" data-testid="stage-heading">
          {STAGE_TITLE[stage]}
        </h2>
        {body}
      </FlowLayout>
    </>
  );
}

function FlowLayout({ rail, children }: { rail: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <div className="lg:sticky lg:top-0 lg:self-start">{rail}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** The harmonization screen: a staged flow (set up, run, review and flag, export) with a stepper. */
export default function HarmonizePage() {
  const [isRun, params] = useRoute<{ jobId: string; stage?: string }>("/harmonize/runs/:jobId/:stage?");
  if (isRun && params) return <OpenRun key={params.jobId} jobId={params.jobId} requested={params.stage} />;
  return (
    <>
      <PageHeader run={null} />
      <FlowLayout
        rail={
          <div className="space-y-6">
            <StageRail jobId={null} current="setup" run={null} flaggedTotal={null} />
            <RunsList />
          </div>
        }
      >
        <SetupStage />
      </FlowLayout>
    </>
  );
}

