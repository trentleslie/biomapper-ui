import type { ReactNode } from "react";
import { AlertOctagon, AlertTriangle, CheckCircle2, Info, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { stateInfo, type StateTone } from "@/lib/harmonize";

/** A run's state in words, with a dot; never blank. */
export function StateBadge({ state, className }: { state: string | undefined | null; className?: string }) {
  const info = stateInfo(state);
  return (
    <Badge variant={info.tone} className={className} data-testid="run-state">
      <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", DOT[info.tone])} />
      {info.label}
    </Badge>
  );
}

const DOT: Record<StateTone, string> = {
  neutral: "bg-neutral-400",
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

const NOTE_TONES = {
  info: "bg-info-bg border-info-border text-info",
  success: "bg-success-bg border-success-border text-success",
  warning: "bg-warning-bg border-warning-border text-warning",
  danger: "bg-danger-bg border-danger-border text-danger",
} as const;
const NOTE_ICONS: Record<keyof typeof NOTE_TONES, LucideIcon> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: AlertOctagon,
};

/** An inline message (Phenome §5.5). Danger notes are announced; others are polite. */
export function Note({
  tone = "info",
  title,
  children,
  action,
  className,
  testId,
}: {
  tone?: keyof typeof NOTE_TONES;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
  testId?: string;
}) {
  const Icon = NOTE_ICONS[tone];
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      data-testid={testId}
      className={cn("flex gap-3 rounded border p-4", NOTE_TONES[tone], className)}
    >
      <Icon aria-hidden size={18} strokeWidth={1.5} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        {title && <p className="mb-1 text-sm font-semibold">{title}</p>}
        {children && <div className="text-sm text-neutral-700 [overflow-wrap:anywhere]">{children}</div>}
        {action && <div className="mt-3">{action}</div>}
      </div>
    </div>
  );
}

/** A failed load: what failed, the server's message as written, and a retry. */
export function ErrorPanel({ title, message, onRetry }: { title: string; message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded border border-danger-border bg-danger-bg p-4">
      <p className="text-sm font-semibold text-danger">{title}</p>
      <p className="mt-1 text-sm text-neutral-700 [overflow-wrap:anywhere]">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  compact,
}: {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 text-center", compact ? "py-6" : "py-12")}>
      {Icon && <Icon aria-hidden size={32} strokeWidth={1.5} className="mb-3 text-neutral-300" />}
      <p className="text-sm font-semibold text-neutral-900">{title}</p>
      {description && <p className="mt-1 max-w-md text-sm text-neutral-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Skeleton lines shaped like the content that is loading. */
export function LoadingBlock({ lines = 3, label = "Loading" }: { lines?: number; label?: string }) {
  return (
    <div role="status" aria-label={label} aria-busy="true" className="space-y-3 rounded border border-neutral-200 bg-white p-6">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="h-4 animate-pulse rounded bg-neutral-100 motion-reduce:animate-none" style={{ width: `${40 + ((i * 17) % 50)}%` }} />
      ))}
    </div>
  );
}

/** A titled white panel (Phenome card: border, no shadow). */
export function Panel({
  title,
  description,
  actions,
  children,
  className,
  id,
  headingLevel = 2,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
  headingLevel?: 2 | 3;
}) {
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <section aria-labelledby={id ? `${id}-title` : undefined} className={cn("rounded border border-neutral-200 bg-white", className)}>
      <div className="flex items-start justify-between gap-4 border-b border-neutral-200 px-5 py-3">
        <div className="min-w-0">
          <H id={id ? `${id}-title` : undefined} className="text-base font-semibold text-neutral-900">
            {title}
          </H>
          {description && <p className="mt-0.5 text-sm text-neutral-500">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded border border-neutral-200 bg-white px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-wider text-neutral-500">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-neutral-900">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-neutral-500">{hint}</p>}
    </div>
  );
}

/**
 * A table in a bounded box that scrolls both ways with visible bars (scroll-visible). `caption` names it for
 * screen readers.
 */
export function DataTable({
  caption,
  headers,
  rows,
  empty,
  maxHeight = "max-h-80",
  testId,
}: {
  caption: string;
  headers: ReactNode[];
  rows: ReactNode[][];
  empty: string;
  maxHeight?: string;
  testId?: string;
}) {
  if (rows.length === 0) {
    return <p className="rounded border border-dashed border-neutral-200 px-4 py-3 text-sm text-neutral-500">{empty}</p>;
  }
  return (
    <div className={cn("scroll-visible rounded border border-neutral-200", maxHeight)} data-testid={testId}>
      <table className="w-full text-sm tabular-nums">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 z-10 bg-neutral-50">
          <tr className="border-b border-neutral-200">
            {headers.map((h, i) => (
              <th key={i} scope="col" className="whitespace-nowrap px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-neutral-500">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, r) => (
            <tr key={r} className="border-b border-neutral-100 last:border-b-0">
              {cells.map((c, i) => (
                <td key={i} className="whitespace-nowrap px-3 py-2 align-top text-neutral-900">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** An identifier, in the mono face. */
export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("font-mono text-xs", className)}>{children}</span>;
}

/** Text from a cohort file or the knowledge graph; shown as data, never blank. */
export function Untrusted({ value, empty = "No name" }: { value: string | null | undefined; empty?: string }) {
  if (value == null || value === "") return <span className="text-neutral-400">{empty}</span>;
  return <span>{value}</span>;
}
