import type { ReactNode, SelectHTMLAttributes } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { stateLabel, stateTone, type StateTone } from "@/lib/harmonize";

export function ToneBadge({ tone, children, className }: { tone: StateTone; children: ReactNode; className?: string }) {
  return (
    <Badge variant={tone} className={className}>
      {children}
    </Badge>
  );
}

/** A run state in words, always with text (never colour alone). */
export function StateBadge({ state, className }: { state: string | null | undefined; className?: string }) {
  return (
    <ToneBadge tone={stateTone(state)} className={className}>
      <span data-testid="run-state">{stateLabel(state)}</span>
    </ToneBadge>
  );
}

/** An API message shown in the page, as written. */
export function ErrorBox({
  title,
  message,
  onRetry,
  className,
}: {
  title: string;
  message: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div role="alert" className={cn("rounded border border-danger-border bg-danger-bg p-3", className)}>
      <p className="flex items-center gap-2 text-sm font-semibold text-danger">
        <AlertTriangle aria-hidden className="h-4 w-4 shrink-0" />
        {title}
      </p>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-neutral-700">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-2" onClick={onRetry}>
          <RefreshCw aria-hidden /> Try again
        </Button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      {icon && <div className="mb-3 text-neutral-300">{icon}</div>}
      <p className="text-sm font-semibold text-neutral-900">{title}</p>
      {description && <div className="mt-1 max-w-lg text-sm text-neutral-500">{description}</div>}
      {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-3" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-7 animate-pulse rounded bg-neutral-100" />
      ))}
    </div>
  );
}

/** A compact native select: dense, keyboard friendly, labelled. */
export function NativeSelect({
  label,
  hideLabel,
  inline,
  className,
  children,
  id,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string; hideLabel?: boolean; inline?: boolean }) {
  const selectId = id ?? `sel-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <div className={cn("flex gap-1 text-xs font-medium text-neutral-600", inline ? "items-center gap-1.5" : "flex-col", className)}>
      <label htmlFor={selectId} className={hideLabel ? "sr-only" : undefined}>
        {label}
      </label>
      <select
        id={selectId}
        className="h-8 min-w-0 rounded border border-neutral-300 bg-white px-2 text-sm font-normal text-neutral-900 focus-visible:ring-2 focus-visible:ring-ph-navy disabled:opacity-50"
        {...props}
      >
        {children}
      </select>
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[11px] font-medium uppercase tracking-wider text-neutral-500" title={label}>
        {label}
      </p>
      <p className="tabular text-base font-semibold text-neutral-900">{value}</p>
      {sub && <p className="text-xs text-neutral-500">{sub}</p>}
    </div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">{children}</h3>;
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("font-mono text-[12px]", className)}>{children}</span>;
}
