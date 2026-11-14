import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, Loader2, Pause, Play, Square } from "lucide-react";
import {
  cancelHarmonizeRun,
  getGetHarmonizeRunQueryKey,
  getListHarmonizeRunsQueryKey,
  resumeHarmonizeRun,
  type HarmonizeRunStatus,
} from "@workspace/api-client-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  armLabel,
  armProgress,
  armsFor,
  canCancel,
  canResume,
  errorMessage,
  formatWhen,
  hasResults,
  isActive,
  plural,
  stateInfo,
} from "@/lib/harmonize";
import { Note, Panel, StateBadge } from "./common";
import { stageHref } from "./StageRail";

const STAGE_WORD: Record<string, string> = {
  queued: "Waiting to start",
  mapping: "Mapping names to the knowledge graph",
  building: "Building links",
  capture: "Capturing review evidence",
  placing: "Placing rows into groups",
  done: "Done",
};

/** Run stage: the state in words, the current arm's progress, cancel and resume. */
export function RunStage({ run }: { run: HarmonizeRunStatus }) {
  const queryClient = useQueryClient();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState<"cancel" | "resume" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const info = stateInfo(run.state);
  const progress = armProgress(run.progress);
  const arms = armsFor(run.kind);
  const currentArmIndex = progress ? arms.indexOf(progress.arm) : -1;
  const finished = hasResults(run.state);
  const isTwo = run.kind === "harmonize_cohorts";

  const act = async (what: "cancel" | "resume") => {
    setBusy(what);
    setActionError(null);
    try {
      const next = what === "cancel" ? await cancelHarmonizeRun(run.jobId) : await resumeHarmonizeRun(run.jobId);
      queryClient.setQueryData(getGetHarmonizeRunQueryKey(run.jobId), next);
      void queryClient.invalidateQueries({ queryKey: getGetHarmonizeRunQueryKey(run.jobId) });
      void queryClient.invalidateQueries({ queryKey: getListHarmonizeRunsQueryKey() });
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <Panel
        id="run-status"
        title="Run status"
        actions={
          <>
            {canResume(run) && (
              <Button onClick={() => act("resume")} disabled={busy !== null}>
                {busy === "resume" ? <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" /> : <Play aria-hidden />}
                Resume run
              </Button>
            )}
            {canCancel(run) && (
              <Button variant="secondary" onClick={() => setConfirmCancel(true)} disabled={busy !== null}>
                {busy === "cancel" ? <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" /> : <Square aria-hidden />}
                Cancel run
              </Button>
            )}
          </>
        }
      >
        <div className="space-y-5" aria-live="polite">
          <div className="flex flex-wrap items-center gap-3">
            <StateBadge state={run.state} className="text-sm" />
            {info.meaning && !run.reason && <p className="text-sm text-neutral-600">{info.meaning}</p>}
          </div>
          {run.reason && (
            <Note tone={run.state === "failed" ? "danger" : "info"} title="Reason" testId="run-reason">
              {run.reason}
            </Note>
          )}
          {run.stage && (
            <p className="text-sm text-neutral-600">
              <span className="font-medium text-neutral-900">Step: </span>
              {STAGE_WORD[run.stage] ?? run.stage}
            </p>
          )}

          {run.kind !== "harmonize_results" && (
            <ol aria-label="Arms of this run" className="grid gap-3 md:grid-cols-3">
              {arms.map((arm, i) => {
                const isCurrent = !finished && i === currentArmIndex;
                const isDone = finished || (currentArmIndex >= 0 && i < currentArmIndex);
                return (
                  <li
                    key={arm}
                    aria-current={isCurrent ? "step" : undefined}
                    className={cn(
                      "rounded border px-4 py-3",
                      isCurrent ? "border-ph-navy bg-neutral-50" : "border-neutral-200 bg-white",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-neutral-900">{armLabel(arm)}</span>
                      <span className="text-xs text-neutral-500">
                        {isDone ? (
                          <span className="inline-flex items-center gap-1 text-success">
                            <Check aria-hidden className="h-3.5 w-3.5" /> Done
                          </span>
                        ) : isCurrent ? (
                          "Now"
                        ) : (
                          "Next"
                        )}
                      </span>
                    </div>
                    {isCurrent && progress && (
                      <div className="mt-2 space-y-1.5" data-testid="arm-progress">
                        <div
                          role="progressbar"
                          aria-label={`${armLabel(arm)} progress`}
                          aria-valuemin={0}
                          aria-valuemax={progress.total}
                          aria-valuenow={progress.done}
                          aria-valuetext={`${progress.done} of ${progress.total} entities`}
                          className="h-2 w-full overflow-hidden rounded-full bg-neutral-200"
                        >
                          <div className="h-full bg-ph-navy transition-[width] motion-reduce:transition-none" style={{ width: `${progress.percent}%` }} />
                        </div>
                        <p className="text-xs tabular-nums text-neutral-700">
                          {progress.done.toLocaleString()} of {progress.total.toLocaleString()} entities ({progress.percent}%)
                        </p>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}

          {run.progress && !finished && (
            <div className="text-sm text-neutral-700" data-testid="cohort-progress">
              {isTwo && run.progress.cohort && (
                <p>
                  <span className="font-medium text-neutral-900">Mapping cohort: </span>
                  {run.progress.cohort}
                </p>
              )}
              {run.progress.cohorts && run.progress.cohorts.length > 0 && (
                <p>
                  <span className="font-medium text-neutral-900">{isTwo ? "Cohorts in this step: " : "Cohorts mapped together: "}</span>
                  {run.progress.cohorts.join(", ")}
                </p>
              )}
            </div>
          )}
          {!run.progress && isActive(run.state) && (
            <p className="text-sm text-neutral-500">Waiting for the first progress update.</p>
          )}

          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt className="text-xs text-neutral-500">Cohorts</dt>
              <dd className="text-neutral-900">
                {(run.cohorts ?? run.labels.map((label) => ({ label, rows: null as number | null }))).map((c) => (
                  <span key={c.label} className="mr-3 inline-block">
                    {c.label}
                    {typeof c.rows === "number" && <span className="text-neutral-500"> ({plural(c.rows, "row")})</span>}
                  </span>
                ))}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500">Entity</dt>
              <dd className="text-neutral-900">{run.entity || "Not recorded"}</dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500">Started</dt>
              <dd className="text-neutral-900">{formatWhen(run.createdAt)}</dd>
            </div>
            {run.updatedUtc && (
              <div>
                <dt className="text-xs text-neutral-500">Last update</dt>
                <dd className="text-neutral-900">{formatWhen(run.updatedUtc)}</dd>
              </div>
            )}
            {typeof run.etaS === "number" && run.etaS > 0 && !finished && (
              <div>
                <dt className="text-xs text-neutral-500">Estimated time left</dt>
                <dd className="tabular-nums text-neutral-900">{formatDuration(run.etaS)}</dd>
              </div>
            )}
            {typeof run.rowsErrored === "number" && run.rowsErrored > 0 && (
              <div>
                <dt className="text-xs text-neutral-500">Rows that errored</dt>
                <dd className="tabular-nums text-neutral-900">{run.rowsErrored.toLocaleString()}</dd>
              </div>
            )}
          </dl>
          {isActive(run.state) && (
            <p className="flex items-center gap-2 text-xs text-neutral-500">
              <Pause aria-hidden className="h-3.5 w-3.5" />
              You can leave this page. The run keeps going, and it is listed under Your runs when you come back.
            </p>
          )}
        </div>
      </Panel>

      {actionError && (
        <Note tone="danger" title="That did not work">
          {actionError}
        </Note>
      )}

      {finished && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-success-border bg-success-bg px-5 py-4">
          <p className="text-sm font-medium text-success">
            {run.state === "partial" ? "The run finished with some rows unmapped." : "The run is complete."} Next, review the
            results and flag what an expert should check.
          </p>
          <Button asChild size="lg">
            <Link href={stageHref(run.jobId, "review")}>
              Review results <ArrowRight aria-hidden />
            </Link>
          </Button>
        </div>
      )}

      <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this run?</AlertDialogTitle>
            <AlertDialogDescription>
              What was mapped so far is kept. You can resume the run later to continue it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep running</AlertDialogCancel>
            <AlertDialogAction
              className="bg-ph-crimson text-white hover:bg-ph-crimson-dark"
              onClick={() => {
                setConfirmCancel(false);
                void act("cancel");
              }}
            >
              Cancel run
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
