import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetHarmonizeRun,
  getGetHarmonizeRunQueryKey,
  useGetHarmonizeReport,
  getGetHarmonizeReportQueryKey,
  useCancelHarmonizeRun,
  useResumeHarmonizeRun,
  getListHarmonizeRunsQueryKey,
  type HarmonizeRunStatus,
} from "@workspace/api-client-react";
import { Ban, Loader2, PlayCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { FactList, LoadError, Notice, SkeletonLines, StateBadge, formatDateTime } from "@/components/harmonize/common";
import { ResultsOverview } from "@/components/harmonize/ResultsOverview";
import { ItemsPanel } from "@/components/harmonize/ItemsPanel";
import { ReviewItemsPanel } from "@/components/harmonize/ReviewItemsPanel";
import { ExportsPanel } from "@/components/harmonize/ExportsPanel";
import {
  STAGE_LABEL,
  armLabel,
  armProgress,
  canCancel,
  canResume,
  errorMessage,
  errorStatus,
  formatEta,
  isFinished,
  kindLabel,
  pollInterval,
  stateInfo,
  type Report,
} from "@/lib/harmonize";

/** One run: its state, progress while it goes, and every result once it has finished. */
export function RunPanel({ jobId }: { jobId: string }) {
  const queryClient = useQueryClient();
  const status = useGetHarmonizeRun(jobId, {
    query: {
      queryKey: getGetHarmonizeRunQueryKey(jobId),
      retry: (count, err) => errorStatus(err) !== 404 && count < 2,
      refetchInterval: (q) => pollInterval(q.state.data?.state),
    },
  });
  const run = status.data;
  const finished = isFinished(run?.state);

  const report = useGetHarmonizeReport(jobId, {
    query: { queryKey: getGetHarmonizeReportQueryKey(jobId), enabled: finished, staleTime: Infinity, retry: 1 },
  });

  const [actionError, setActionError] = useState<string | null>(null);
  const onAction = {
    onSuccess: (next: HarmonizeRunStatus) => {
      setActionError(null);
      queryClient.setQueryData(getGetHarmonizeRunQueryKey(jobId), next);
      void queryClient.invalidateQueries({ queryKey: getListHarmonizeRunsQueryKey() });
    },
    onError: (e: unknown) => setActionError(errorMessage(e)),
  };
  const cancel = useCancelHarmonizeRun({ mutation: onAction });
  const resume = useResumeHarmonizeRun({ mutation: onAction });

  if (status.isLoading) {
    return (
      <Card>
        <CardContent className="pt-6">
          <SkeletonLines lines={3} label="Loading the run" />
        </CardContent>
      </Card>
    );
  }
  if (status.isError || !run) {
    return (
      <LoadError
        what="this run"
        message={errorStatus(status.error) === 404 ? "This run was not found. It may belong to another account." : errorMessage(status.error)}
        onRetry={() => void status.refetch()}
      />
    );
  }

  const info = stateInfo(run.state);
  const progress = armProgress(run.progress);
  const labels = run.labels ?? [];
  const many = run.kind === "harmonize_many";

  return (
    <div className="space-y-6" data-testid="run-panel">
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-semibold tracking-tight text-neutral-900" data-testid="run-title">
                  {labels.length ? labels.join(" · ") : "Run"}
                </h2>
                <Badge variant="brand">{kindLabel(run.kind)}</Badge>
                <StateBadge state={run.state} />
              </div>
              <p className="text-sm text-neutral-600" data-testid="run-meaning">{info.meaning}</p>
              {run.reason && (
                <p className="text-sm text-neutral-800" data-testid="run-reason">
                  <span className="text-neutral-500">Reason: </span>
                  {run.reason}
                </p>
              )}
            </div>
            <div className="flex gap-2">
              {canCancel(run.kind, run.state) && (
                <Button variant="outline" onClick={() => cancel.mutate({ jobId })} disabled={cancel.isPending} data-testid="btn-cancel-run">
                  {cancel.isPending ? <Loader2 className="animate-spin" /> : <Ban />} Cancel run
                </Button>
              )}
              {canResume(run.kind, run.state) && (
                <Button onClick={() => resume.mutate({ jobId })} disabled={resume.isPending} data-testid="btn-resume-run">
                  {resume.isPending ? <Loader2 className="animate-spin" /> : <PlayCircle />} Resume run
                </Button>
              )}
            </div>
          </div>
          {actionError && <Notice tone="danger" testId="run-action-error">{actionError}</Notice>}

          <FactList
            testId="run-facts"
            rows={[
              { label: "Entity", value: <span className="font-mono">{run.entity || "not recorded"}</span> },
              { label: "Cohorts", value: run.cohorts?.length
                ? run.cohorts.map((c) => `${c.label} (${c.rows.toLocaleString()} rows)`).join(", ")
                : labels.join(", ") || "not recorded" },
              { label: "Started", value: formatDateTime(run.createdAt) },
              ...(run.stage ? [{ label: "Stage", value: STAGE_LABEL[run.stage] ?? run.stage }] : []),
              ...(run.kgBuild ? [{
                label: "KG build",
                value: run.kgBuild === "unknown" ? "not recorded for this kind of run" : `${run.kgBuild}${run.kgVerified ? " (verified)" : " (not verified)"}`,
              }] : []),
              ...(run.rowsErrored ? [{ label: "Rows errored", value: run.rowsErrored.toLocaleString() }] : []),
            ]}
          />

          {!finished && run.state !== "failed" && run.state !== "unknown" && (
            <div className="rounded border border-neutral-200 bg-neutral-50 p-4" data-testid="run-progress">
              {progress ? (
                <>
                  <div className="mb-2 flex flex-wrap justify-between gap-2 text-sm font-medium">
                    <span>
                      {armLabel(progress.arm)} arm: {progress.done.toLocaleString()} of {progress.total.toLocaleString()} entities
                    </span>
                    <span className="tabular-nums">{progress.percent}%</span>
                  </div>
                  <Progress value={progress.percent} className="h-2" aria-label={`${armLabel(progress.arm)} arm progress`} />
                  <p className="mt-2 text-xs text-neutral-600" data-testid="run-progress-cohort">
                    {!many && run.progress?.cohort
                      ? `Mapping cohort ${run.progress.cohort} now.`
                      : run.progress?.cohorts?.length
                        ? `Cohorts mapped together: ${run.progress.cohorts.join(", ")}.`
                        : null}
                    {formatEta(run.etaS) ? ` Estimated time left: ${formatEta(run.etaS)}.` : ""}
                  </p>
                  <p className="mt-1 text-xs text-neutral-500">
                    Runs map every row twice: once by name only, then with identifiers{many ? "" : ", then a review pass"}.
                    You can leave this page; the run keeps going and is listed under Your runs.
                  </p>
                </>
              ) : (
                <p className="text-sm text-neutral-600">
                  {run.state === "queued" ? "Waiting to start. Progress appears here once mapping begins." : "No progress reported yet."}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {finished && (
        report.isLoading ? (
          <Card><CardContent className="pt-6"><SkeletonLines lines={5} label="Loading the results" /></CardContent></Card>
        ) : report.isError || !report.data ? (
          <LoadError what="the results" message={errorMessage(report.error)} onRetry={() => void report.refetch()} />
        ) : (
          <>
            <ResultsOverview report={report.data as Report} run={run} />
            <ItemsPanel jobId={jobId} kind={run.kind} />
            <ReviewItemsPanel jobId={jobId} />
            <ExportsPanel jobId={jobId} kind={run.kind} />
          </>
        )
      )}
    </div>
  );
}
