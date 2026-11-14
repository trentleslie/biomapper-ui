import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Ban, Loader2, Play, Plus } from "lucide-react";
import {
  cancelHarmonizeRun,
  getGetHarmonizeRunQueryKey,
  getListHarmonizeRunsQueryKey,
  resumeHarmonizeRun,
  type HarmonizeRunStatus,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import {
  apiErrorMessage,
  canCancel,
  canResume,
  entityLabel,
  formatWhen,
  hasResults,
  isActive,
  kindLabel,
  progressView,
  stateLabel,
} from "@/lib/harmonize";
import { EmptyState, ErrorBox, SkeletonRows, StateBadge } from "./primitives";

export function runTitle(run: Pick<HarmonizeRunStatus, "labels">): string {
  const labels = run.labels ?? [];
  if (labels.length === 0) return "Unnamed run";
  if (labels.length <= 2) return labels.join(" and ");
  return `${labels[0]} and ${labels.length - 1} more`;
}

/** One line of progress for the run list: the current arm and its own count. */
function shortProgress(run: HarmonizeRunStatus): string | null {
  if (!isActive(run.state)) return null;
  const p = progressView(run.progress);
  if (!p) return run.state === "queued" ? "Waiting to start" : "Starting";
  return `${p.armLabel}: ${p.done} of ${p.total}`;
}

// ---------------------------------------------------------------------------
// The run list (left column)
// ---------------------------------------------------------------------------

export function RunList({
  runs,
  isLoading,
  error,
  onRetry,
  selectedId,
  onNewRun,
}: {
  runs: HarmonizeRunStatus[] | undefined;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  selectedId: string | null;
  onNewRun: () => void;
}) {
  return (
    <aside aria-label="Harmonization runs" className="flex w-64 shrink-0 flex-col rounded border border-neutral-200 bg-white">
      <div className="flex items-center justify-between gap-2 border-b border-neutral-200 px-3 py-2">
        <h2 className="text-sm font-semibold text-neutral-900">Your runs</h2>
        <Button size="sm" onClick={onNewRun}>
          <Plus aria-hidden /> New run
        </Button>
      </div>
      <div data-testid="run-list" className="min-h-0 flex-1 scroll-visible">
        {isLoading ? (
          <SkeletonRows rows={4} />
        ) : error ? (
          <div className="p-2">
            <ErrorBox title="Could not load your runs" message={apiErrorMessage(error)} onRetry={onRetry} />
          </div>
        ) : !runs || runs.length === 0 ? (
          <p className="p-3 text-sm text-neutral-500">No runs yet. Start one with New run, or try a built-in example.</p>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {runs.map((run) => {
              const selected = run.jobId === selectedId;
              const progress = shortProgress(run);
              return (
                <li key={run.jobId}>
                  <Link
                    href={`/harmonize/${run.jobId}`}
                    aria-current={selected ? "page" : undefined}
                    className={cn(
                      "block px-3 py-2 text-left transition-colors hover:bg-neutral-50",
                      selected && "bg-neutral-100 shadow-[inset_3px_0_0_var(--color-ph-navy)]",
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-neutral-900" title={(run.labels ?? []).join(", ")}>
                        {runTitle(run)}
                      </span>
                      <StateBadge state={run.state} />
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-neutral-500">
                      {kindLabel(run.kind)} · {formatWhen(run.createdAt)}
                    </span>
                    {progress && <span className="mt-0.5 block text-xs text-info">{progress}</span>}
                    {run.state === "unknown" && run.reason && (
                      <span className="mt-0.5 block text-xs text-neutral-600">{run.reason}</span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Cancel and resume
// ---------------------------------------------------------------------------

export function RunControls({ run }: { run: HarmonizeRunStatus }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<"cancel" | "resume" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(kind: "cancel" | "resume") {
    setBusy(kind);
    setError(null);
    try {
      const status = kind === "cancel" ? await cancelHarmonizeRun(run.jobId) : await resumeHarmonizeRun(run.jobId);
      queryClient.setQueryData(getGetHarmonizeRunQueryKey(run.jobId), status);
      await queryClient.invalidateQueries({ queryKey: getGetHarmonizeRunQueryKey(run.jobId) });
      await queryClient.invalidateQueries({ queryKey: getListHarmonizeRunsQueryKey() });
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  if (!canCancel(run) && !canResume(run)) return null;
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        {canCancel(run) && (
          <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => void act("cancel")}>
            {busy === "cancel" ? <Loader2 aria-hidden className="animate-spin" /> : <Ban aria-hidden />}
            Cancel run
          </Button>
        )}
        {canResume(run) && (
          <Button size="sm" disabled={busy !== null} onClick={() => void act("resume")}>
            {busy === "resume" ? <Loader2 aria-hidden className="animate-spin" /> : <Play aria-hidden />}
            Resume run
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="max-w-md text-right text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// While a run is not finished: its state, progress and what to do
// ---------------------------------------------------------------------------

const STAGE_LABELS: Record<string, string> = {
  queued: "waiting in the queue",
  mapping: "mapping names and identifiers",
  building: "building links and groups",
  capture: "capturing review evidence",
  placing: "writing the report",
  done: "done",
};

const STATE_EXPLAINERS: Record<string, string> = {
  queued: "The run is waiting its turn. Runs go one at a time; it starts on its own.",
  running: "Results appear here as soon as the run finishes. You can leave this page; the run keeps going.",
  paused: "The run is paused. Resume it to carry on from where it stopped.",
  stalled: "The run stopped making progress. Resume it to try again from where it stopped.",
  expired: "The run waited too long and expired. Resume it to start it again; what was mapped is kept.",
  cancelled: "The run was cancelled. What was mapped is kept; resume it to finish.",
  failed: "The run failed. The reason is below as the package wrote it.",
  owned_elsewhere: "Another server process holds this run.",
  unknown: "The job runner no longer knows this run.",
};

export function ProgressPanel({ run }: { run: HarmonizeRunStatus }) {
  const p = progressView(run.progress);
  const cohortsTogether = run.progress?.cohorts ?? [];
  return (
    <section aria-label="Run progress" className="flex flex-1 flex-col items-center justify-center rounded border border-neutral-200 bg-white p-8">
      <div className="w-full max-w-xl space-y-4">
        <div className="flex items-center gap-3">
          <StateBadge state={run.state} />
          <p className="text-sm text-neutral-700">{STATE_EXPLAINERS[run.state] ?? stateLabel(run.state)}</p>
        </div>
        {run.reason && (
          <p className="rounded border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-800" data-testid="run-reason">
            {run.reason}
          </p>
        )}
        {isActive(run.state) && (
          <div className="space-y-2" aria-live="polite">
            {p ? (
              <>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="font-medium text-neutral-900" data-testid="progress-arm">
                    Arm: {p.armLabel}
                  </span>
                  <span className="tabular text-neutral-700" data-testid="progress-count">
                    {p.text} ({p.percent}%)
                  </span>
                </div>
                <Progress value={p.percent} aria-label={`${p.armLabel} arm progress`} />
                {run.progress?.cohort && (
                  <p className="text-sm text-neutral-700" data-testid="progress-cohort">
                    Mapping cohort <span className="font-medium">{run.progress.cohort}</span> now
                  </p>
                )}
                {!run.progress?.cohort && cohortsTogether.length > 0 && (
                  <p className="text-sm text-neutral-700" data-testid="progress-cohorts">
                    Mapping {cohortsTogether.length} cohorts together: {cohortsTogether.join(", ")}
                  </p>
                )}
              </>
            ) : (
              <p className="flex items-center gap-2 text-sm text-neutral-700">
                <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
                {run.state === "queued" ? "Waiting to start" : "Starting the first arm"}
              </p>
            )}
            {run.stage && <p className="text-xs text-neutral-500">Stage: {STAGE_LABELS[run.stage] ?? run.stage}</p>}
            {typeof run.etaS === "number" && run.etaS > 0 && (
              <p className="text-xs text-neutral-500">About {Math.max(1, Math.round(run.etaS / 60))} min left</p>
            )}
          </div>
        )}
        <div className="flex justify-end">
          <RunControls run={run} />
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The header over the workbench
// ---------------------------------------------------------------------------

export function RunHeader({
  run,
  actions,
}: {
  run: HarmonizeRunStatus;
  actions?: React.ReactNode;
}) {
  const p = progressView(run.progress);
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 rounded border border-neutral-200 bg-white px-4 py-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="truncate text-lg font-semibold text-neutral-900" title={(run.labels ?? []).join(", ")}>
            {runTitle(run)}
          </h1>
          <StateBadge state={run.state} />
        </div>
        <p className="mt-0.5 text-xs text-neutral-500">
          {kindLabel(run.kind)} · {entityLabel(run.entity)} · {(run.labels ?? []).length} cohorts · started {formatWhen(run.createdAt)}
          {isActive(run.state) && p && (
            <span className="text-info">
              {" "}
              · {p.armLabel} arm {p.done} of {p.total}
            </span>
          )}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {hasResults(run.state) && actions}
      </div>
    </header>
  );
}

export function NoRunSelected({ onNewRun, onExample }: { onNewRun: () => void; onExample: (kind: "two_cohort" | "many_cohort") => void }) {
  return (
    <div className="flex flex-1 items-center justify-center rounded border border-dashed border-neutral-300 bg-white">
      <EmptyState
        title="Harmonize cohorts"
        description={
          <>
            Find which rows in two or more cohort files are the same entity, review and flag the links and groups,
            and export them for expert review. Start with your own files, two finished mapping jobs, or a built-in
            example.
          </>
        }
        action={
          <>
            <Button onClick={onNewRun}>
              <Plus aria-hidden /> New run
            </Button>
            <Button variant="secondary" onClick={() => onExample("two_cohort")}>
              Run the two-cohort example
            </Button>
            <Button variant="secondary" onClick={() => onExample("many_cohort")}>
              Run the many-cohort example
            </Button>
          </>
        }
      />
    </div>
  );
}
