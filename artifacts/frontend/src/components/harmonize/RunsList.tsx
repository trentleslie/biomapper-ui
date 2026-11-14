import { useListHarmonizeRuns, getListHarmonizeRunsQueryKey } from "@workspace/api-client-react";
import { History } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, LoadError, SkeletonLines, StateBadge, formatDateTime } from "@/components/harmonize/common";
import { errorMessage, isWaiting, kindLabel } from "@/lib/harmonize";
import { cn } from "@/lib/utils";

/**
 * The user's runs, newest first, each with its state. It refreshes itself while any run is still moving, so a run
 * started earlier is found here (and keeps progressing) after the user leaves the page and comes back.
 */
export function RunsList({ selected, onSelect }: { selected: string | null; onSelect: (jobId: string) => void }) {
  const runs = useListHarmonizeRuns({
    query: {
      queryKey: getListHarmonizeRunsQueryKey(),
      retry: 1,
      refetchInterval: (q) => ((q.state.data ?? []).some((r) => isWaiting(r.state)) ? 3000 : 15000),
    },
  });

  return (
    <Card data-testid="runs-list">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Your runs</CardTitle>
        <CardDescription>Open a run to see its progress and results below.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {runs.isLoading ? (
          <div className="px-6 pb-6">
            <SkeletonLines lines={4} label="Loading your runs" />
          </div>
        ) : runs.isError ? (
          <div className="px-6 pb-6">
            <LoadError what="your runs" message={errorMessage(runs.error)} onRetry={() => void runs.refetch()} />
          </div>
        ) : (runs.data ?? []).length === 0 ? (
          <EmptyState
            icon={History}
            title="No runs yet"
            description="Runs you start from this page are listed here, so you can leave and come back to them."
          />
        ) : (
          <ul className="max-h-[28rem] scroll-visible border-t border-neutral-200 lg:max-h-[calc(100dvh-16rem)]" aria-label="Your harmonization runs">
            {(runs.data ?? []).map((r) => {
              const active = r.jobId === selected;
              const labels = (r.labels ?? []).join(", ") || "Unlabelled cohorts";
              return (
                <li key={r.jobId} className="border-b border-neutral-100 last:border-0">
                  <button
                    type="button"
                    onClick={() => onSelect(r.jobId)}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "flex w-full flex-col gap-1 px-6 py-3 text-left transition-colors hover:bg-neutral-50 focus-visible:bg-neutral-50",
                      active && "bg-ph-navy/5",
                    )}
                    data-testid="run-row"
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-neutral-900" title={labels}>{labels}</span>
                      <StateBadge state={r.state} className="shrink-0" />
                    </span>
                    <span className="text-xs text-neutral-500">
                      {kindLabel(r.kind)} · {r.entity || "entity not recorded"} · {formatDateTime(r.createdAt)}
                    </span>
                    {r.state === "unknown" && r.reason && (
                      <span className="text-xs text-neutral-600" data-testid="run-row-reason">{r.reason}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
