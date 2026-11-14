import { Link } from "wouter";
import { History } from "lucide-react";
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
      <div className="border-b border-neutral-200 px-4 py-2.5">
        <h2 id="your-runs-title" className="text-sm font-semibold text-neutral-900">
          Your runs
        </h2>
        <p className="text-xs text-neutral-500">
          {active.length > 0
            ? `${active.length} still going. Runs continue while you are away.`
            : "Open one to pick up where you left off."}
        </p>
      </div>
      {q.isLoading ? (
        <div className="p-3">
          <LoadingBlock lines={3} label="Loading your runs" />
        </div>
      ) : q.isError && !q.data ? (
        <div className="p-3">
          <ErrorPanel title="Your runs did not load" message={errorMessage(q.error)} onRetry={() => q.refetch()} />
        </div>
      ) : runs.length === 0 ? (
        <EmptyState compact icon={History} title="No runs yet" description="Runs you start appear here, with their state." />
      ) : (
        <>
        {q.isError && (
          <p role="status" className="px-4 pt-2 text-xs text-warning" data-testid="runs-refresh-failed">
            Could not refresh the list ({errorMessage(q.error)}). Showing the last one received.
          </p>
        )}
        <ul className="scroll-visible max-h-[min(26rem,calc(100vh-24rem))] min-h-24 divide-y divide-neutral-100" aria-label="Harmonization runs">
          {runs.map((r) => {
            const p = r.state === "running" ? armProgress(r.progress) : null;
            return (
              <li key={r.jobId}>
                <Link
                  href={stageHref(r.jobId, defaultStage(r.state))}
                  className="block px-4 py-2.5 hover:bg-neutral-50"
                  aria-label={`Open ${stateInfo(r.state).label.toLowerCase()} run: ${r.labels.join(", ")} (${kindLabel(r.kind)})`}
                >
                  <span className="block truncate text-sm font-medium text-neutral-900" title={r.labels.join(", ")}>
                    {r.labels.join(", ") || "Unlabelled run"}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <StateBadge state={r.state} />
                    <span className="text-xs text-neutral-500">{kindLabel(r.kind)}</span>
                  </span>
                  {p && (
                    <span className="mt-1 block text-xs tabular-nums text-neutral-600">
                      {armLabel(p.arm)}: {p.done} of {p.total}
                    </span>
                  )}
                  <span className="mt-0.5 block text-xs text-neutral-500">{formatWhen(r.createdAt)}</span>
                  {r.state === "unknown" && r.reason && <span className="mt-0.5 block text-xs text-neutral-700">{r.reason}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
        </>
      )}
    </section>
  );
}
