import { Link } from "wouter";
import { Check, Lock } from "lucide-react";
import type { HarmonizeRunStatus } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import {
  STAGES,
  STAGE_TITLE,
  armLabel,
  armProgress,
  hasResults,
  kindLabel,
  plural,
  stageReachable,
  stateInfo,
  type Stage,
} from "@/lib/harmonize";

export function stageHref(jobId: string | null, stage: Stage): string {
  if (!jobId) return "/harmonize";
  return `/harmonize/runs/${encodeURIComponent(jobId)}/${stage}`;
}

type StepState = "done" | "current" | "open" | "locked";

interface StepView {
  stage: Stage;
  state: StepState;
  status: string;
}

/** What each step of the flow says about the run, and whether it can be opened. Exported for tests. */
export function stepViews(
  current: Stage,
  run: HarmonizeRunStatus | null,
  flaggedTotal: number | null,
): StepView[] {
  return STAGES.map((stage) => {
    if (!run) {
      if (stage === "setup") return { stage, state: "current", status: "Choose files, jobs or an example" };
      return {
        stage,
        state: "locked",
        status: stage === "run" ? "Starts when you start a run" : "Available once a run finishes",
      };
    }
    const reachable = stageReachable(stage, run.state);
    const finished = hasResults(run.state);
    let status = "";
    let done = false;
    switch (stage) {
      case "setup":
        status = run.kind === "harmonize_many" ? `Many cohorts: ${run.labels.length}` : kindLabel(run.kind);
        done = true;
        break;
      case "run": {
        const info = stateInfo(run.state);
        const p = armProgress(run.progress);
        status = run.state === "running" && p ? `${info.label}: ${armLabel(p.arm)} ${p.percent}%` : info.label;
        done = finished;
        break;
      }
      case "review":
        status = finished
          ? flaggedTotal == null
            ? "Results ready"
            : `${plural(flaggedTotal, "item")} flagged`
          : "Available when the run is complete";
        break;
      case "export":
        status = finished ? "EITL pairs and tables" : "Available when the run is complete";
        break;
    }
    const state: StepState = stage === current ? "current" : !reachable ? "locked" : done ? "done" : "open";
    return { stage, state, status };
  });
}

/**
 * The flow's stepper: always shows where the researcher is, what is done and what comes next. Steps that need
 * the run's results stay locked (with the reason) until it finishes; earlier steps stay reachable.
 */
export function StageRail({
  jobId,
  current,
  run,
  flaggedTotal,
}: {
  jobId: string | null;
  current: Stage;
  run: HarmonizeRunStatus | null;
  flaggedTotal: number | null;
}) {
  const views = stepViews(current, run, flaggedTotal);
  return (
    <nav aria-label="Harmonization steps" data-testid="stage-rail">
      <ol className="flex flex-col gap-1 sm:flex-row lg:flex-col">
        {views.map((v, i) => {
          const body = (
            <>
              <span
                aria-hidden
                className={cn(
                  "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums",
                  v.state === "current" && "border-ph-navy bg-ph-navy text-white",
                  v.state === "done" && "border-success bg-success-bg text-success",
                  v.state === "open" && "border-neutral-300 bg-white text-neutral-700",
                  v.state === "locked" && "border-neutral-200 bg-neutral-50 text-neutral-400",
                )}
              >
                {v.state === "done" ? <Check className="h-3.5 w-3.5" /> : v.state === "locked" ? <Lock className="h-3 w-3" /> : i + 1}
              </span>
              <span className="min-w-0">
                <span className={cn("block text-sm font-medium", v.state === "locked" ? "text-neutral-400" : "text-neutral-900")}>
                  {STAGE_TITLE[v.stage]}
                </span>
                <span className="block text-xs text-neutral-500">{v.status}</span>
              </span>
            </>
          );
          const cls = cn(
            "flex w-full items-start gap-3 rounded border-l-2 px-3 py-2 text-left",
            v.state === "current" ? "border-ph-navy bg-neutral-100" : "border-transparent",
            v.state !== "locked" && v.state !== "current" && "hover:bg-neutral-50",
          );
          const label = `Step ${i + 1}: ${STAGE_TITLE[v.stage]}. ${v.status}`;
          return (
            <li key={v.stage} className="min-w-0 flex-1 lg:flex-none">
              {v.state === "locked" || (v.state === "current" && !jobId && v.stage === "setup") ? (
                <div
                  className={cls}
                  aria-current={v.state === "current" ? "step" : undefined}
                  aria-disabled={v.state === "locked" ? "true" : undefined}
                  aria-label={label}
                >
                  {body}
                </div>
              ) : (
                <Link
                  href={stageHref(jobId, v.stage)}
                  className={cls}
                  aria-current={v.state === "current" ? "step" : undefined}
                  aria-label={label}
                >
                  {body}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
