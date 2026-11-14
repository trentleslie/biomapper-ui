import { Link } from "wouter";
import { ChevronRight, History } from "lucide-react";
import { getListHarmonizeRunsQueryKey, useListHarmonizeRuns } from "@workspace/api-client-react";
import { armLabel, armProgress, defaultStage, errorMessage, formatWhen, isActive, kindLabel, stateInfo } from "@/lib/harmonize";
import { EmptyState, ErrorPanel, LoadingBlock, StateBadge } from "./common";
import { stageHref } from "./StageRail";

/** The user's runs, newest first, each with its state; a run the job runner lost is listed as unknown with its reason. */
export function RunsList() {
  const q = useListHarmonizeRuns({
    query: {
      queryKey: getListHarmonizeRunsQueryKey(),
      refetchInterval: (query) => (query.state.data?.some((r) => isActive(r.state)) ? 3000 : false),
    },
  });
  const runs = q.data ?? [];
  const active = runs.filter((r) => isActive(r.state));

  return (
    <section aria-labelledby="your-runs-title" className="rounded border border-neutral-200 bg-white" data-testid="runs-list">
      <div className="flex items-center justify-between gap-3 border-b border-neutral-200 px-5 py-3">
        <div>
          <h2 id="your-runs-title" className="text-base font-semibold text-neutral-900">
            Your runs
          </h2>
          <p className="text-sm text-neutral-500">
            {active.length > 0
              ? `${active.length} still going. Runs continue while you are away.`
              : "Open a run to pick up where you left off."}
          </p>
        </div>
      </div>
      {q.isLoading ? (
        <div className="p-4">
          <LoadingBlock lines={3} label="Loading your runs" />
        </div>
      ) : q.isError ? (
        <div className="p-4">
          <ErrorPanel title="Your runs did not load" message={errorMessage(q.error)} onRetry={() => q.refetch()} />
        </div>
      ) : runs.length === 0 ? (
        <EmptyState compact icon={History} title="No runs yet" description="Runs you start appear here, with their state, so you can come back to them." />
      ) : (
        <ul className="scroll-visible max-h-72 divide-y divide-neutral-100" aria-label="Harmonization runs">
          {runs.map((r) => {
            const p = r.state === "running" ? armProgress(r.progress) : null;
            return (
              <li key={r.jobId}>
                <Link
                  href={stageHref(r.jobId, defaultStage(r.state))}
                  className="flex items-center gap-4 px-5 py-3 hover:bg-neutral-50"
                  aria-label={`Open ${stateInfo(r.state).label.toLowerCase()} run: ${r.labels.join(", ")} (${kindLabel(r.kind)})`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-neutral-900" title={r.labels.join(", ")}>
                      {r.labels.join(", ") || "Unlabelled run"}
                    </p>
                    <p className="text-xs text-neutral-500">
                      {kindLabel(r.kind)}, {r.entity || "entity not recorded"}, started {formatWhen(r.createdAt)}
                    </p>
                    {r.state === "unknown" && r.reason && <p className="mt-0.5 text-xs text-neutral-700">{r.reason}</p>}
                  </div>
                  {p && (
                    <span className="hidden text-xs tabular-nums text-neutral-600 sm:block">
                      {armLabel(p.arm)}: {p.done} of {p.total}
                    </span>
                  )}
                  <StateBadge state={r.state} />
                  <ChevronRight aria-hidden className="h-4 w-4 text-neutral-400" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
