import type { ReactNode } from "react";
import { AlertTriangle, AlertOctagon, Info, CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { stateInfo, type Tone } from "@/lib/harmonize";
import { cn } from "@/lib/utils";

/** A run's state as a word with its tone. Never blank (see stateInfo). */
export function StateBadge({ state, className }: { state: string | null | undefined; className?: string }) {
  const info = stateInfo(state);
  return (
    <Badge variant={info.tone} className={className} data-testid="run-state">
      <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", dotClass(info.tone))} />
      {info.word}
    </Badge>
  );
}

function dotClass(tone: Tone) {
  return {
    neutral: "bg-neutral-500",
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-danger",
    info: "bg-info",
  }[tone];
}

const NOTICE_TONES = {
  info: { box: "bg-info-bg border-info-border text-info", Icon: Info },
  success: { box: "bg-success-bg border-success-border text-success", Icon: CheckCircle2 },
  warning: { box: "bg-warning-bg border-warning-border text-warning", Icon: AlertTriangle },
  danger: { box: "bg-danger-bg border-danger-border text-danger", Icon: AlertOctagon },
};

/**
 * An inline message (the design system's Alert recipe). Danger notices are role=alert so a screen reader hears a
 * refusal at once. Others are plain content unless `live` (the result of something the user just did), which
 * makes them a polite status message.
 */
export function Notice({
  tone = "info",
  title,
  children,
  action,
  className,
  testId,
  live = false,
}: {
  live?: boolean;
  tone?: keyof typeof NOTICE_TONES;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
  testId?: string;
}) {
  const { box, Icon } = NOTICE_TONES[tone];
  return (
    <div
      role={tone === "danger" ? "alert" : live ? "status" : undefined}
      className={cn("flex gap-3 rounded border p-3", box, className)}
      data-testid={testId}
    >
      <Icon aria-hidden size={18} strokeWidth={1.5} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        {title && <p className="text-sm font-semibold">{title}</p>}
        {children && <div className={cn("text-sm text-neutral-800", title && "mt-0.5")}>{children}</div>}
        {action && <div className="mt-2">{action}</div>}
      </div>
    </div>
  );
}

/** The error state of an async surface: what failed, the API's message as written, and a retry. */
export function LoadError({ what, message, onRetry }: { what: string; message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded border border-danger-border bg-danger-bg p-4">
      <p className="text-sm font-semibold text-danger">Couldn't load {what}</p>
      <p className="mt-1 text-sm text-neutral-700">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function SkeletonLines({ lines = 3, label }: { lines?: number; label: string }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label={label} role="status">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="h-4 animate-pulse rounded bg-neutral-100" style={{ width: `${70 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, description, action }: {
  icon?: React.ComponentType<{ size?: number; className?: string; strokeWidth?: number }>;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      {Icon && <Icon size={32} strokeWidth={1.5} className="mb-3 text-neutral-300" />}
      <p className="text-sm font-semibold text-neutral-900">{title}</p>
      {description && <div className="mt-1 max-w-md text-sm text-neutral-500">{description}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Label and value in a compact two-column list. */
export function FactList({ rows, testId }: { rows: Array<{ label: ReactNode; value: ReactNode }>; testId?: string }) {
  return (
    <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-1.5 text-sm" data-testid={testId}>
      {rows.map((r, i) => (
        <div key={i} className="contents">
          <dt className="text-neutral-500">{r.label}</dt>
          <dd className="min-w-0 break-words text-neutral-900">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function formatDateTime(value: string | number | null | undefined): string {
  if (value == null || value === "") return "time not recorded";
  const d = typeof value === "number" ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
