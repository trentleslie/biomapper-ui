import { useState, type ReactNode } from "react";
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
  quiet = false,
}: {
  tone?: keyof typeof NOTE_TONES;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
  testId?: string;
  /** Not a live region: for standing text whose numbers change with other announced actions. */
  quiet?: boolean;
}) {
  const Icon = NOTE_ICONS[tone];
  return (
    <div
      role={quiet ? undefined : tone === "danger" ? "alert" : "status"}
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
  pageSize = TABLE_PAGE,
  noun = "rows",
}: {
  caption: string;
  headers: ReactNode[];
  rows: ReactNode[][];
  empty: string;
  maxHeight?: string;
  testId?: string;
  /** Rows drawn at once; a report can hold tens of thousands. */
  pageSize?: number;
  noun?: string;
}) {
  const [offset, setOffset] = useState(0);
  if (rows.length === 0) {
    return <p className="rounded border border-dashed border-neutral-200 px-4 py-3 text-sm text-neutral-500">{empty}</p>;
  }
  const start = offset < rows.length ? offset : 0;
  const shown = rows.slice(start, start + pageSize);
  return (
    <div className="space-y-2">
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
            {shown.map((cells, r) => (
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
      {rows.length > pageSize && <Pager offset={start} pageSize={pageSize} total={rows.length} onOffset={setOffset} noun={noun} />}
    </div>
  );
}

export const TABLE_PAGE = 100;

/** An identifier, in the mono face. */
export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("font-mono text-xs", className)}>{children}</span>;
}

/** Text from a cohort file or the knowledge graph; shown as data, never blank. */
export function Untrusted({ value, empty = "No name" }: { value: string | null | undefined; empty?: string }) {
  if (value == null || value === "") return <span className="text-neutral-400">{empty}</span>;
  return <span>{value}</span>;
}

export function Pager({
  offset,
  pageSize,
  total,
  onOffset,
  noun,
}: {
  offset: number;
  pageSize: number;
  total: number;
  onOffset: (n: number) => void;
  noun: string;
}) {
  if (total === 0) return null;
  const from = offset + 1;
  const to = Math.min(offset + pageSize, total);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-neutral-600">
      <p className="tabular-nums" aria-live="polite">
        Showing {from.toLocaleString()} to {to.toLocaleString()} of {total.toLocaleString()} {noun}
      </p>
      {total > pageSize && (
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - pageSize))}>
            Previous page
          </Button>
          <Button size="sm" variant="secondary" disabled={to >= total} onClick={() => onOffset(offset + pageSize)}>
            Next page
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Glossary: the package's terms in plain words. Every sentence restates the installed biomapper's own wording;
// the source is named beside each entry so it can be checked.
// ---------------------------------------------------------------------------

export const GLOSSARY = {
  // biomapper/harmonize/linking.py, harmonize() and BASIS_ORDER
  basis: {
    term: "Basis",
    text: "Why two rows were linked. node: they share an identifier and both resolved to the same knowledge graph node. identifier: they share an identifier (structure identifiers are not counted). name_exact: their names are equal once spacing is tidied. name_casefold: their names are equal only when letter case is ignored.",
  },
  // linking.py module docstring and Link.to_dict ("one_to_one is not ambiguous")
  ambiguity: {
    term: "One-to-one and ambiguous",
    text: "A link is ambiguous when either of its rows has more than one partner: several rows landed on the same entry, so the pair is a candidate for review rather than a confident match. Every other link is one-to-one.",
  },
  // linking.py, NAME_CASEFOLD_MIN_LENGTH_EXCLUSIVE and harmonize()
  withheld: {
    term: "Withheld name match",
    text: "Two names that are equal only when letter case is ignored, where either name is 4 characters or shorter, are not linked and are listed here instead (Co, cobalt, against CO, carbon monoxide).",
  },
  // linking.py, PossibleMiss
  possibleMiss: {
    term: "Possible miss",
    text: "A row in no link whose mapping carries a review signal: an engine review value, a contradicted certificate, or a mixture name. It may be a missed match rather than a row only one cohort has.",
  },
  // biomapper/harmonize/nway.py module docstring
  multiplicity: {
    term: "Multiplicity",
    text: "A group has multiplicity when one cohort gives it two or more rows.",
  },
  broad: {
    term: "Broad",
    text: "A group is broad when one of its rows resolved to a class-level entry.",
  },
  clean: {
    term: "Clean",
    text: "A group is clean when each cohort in it gives exactly one row and none of its rows resolved to a class-level entry.",
  },
  crossNode: {
    term: "Cross-node entry",
    text: "Links between rows that resolved to different nodes. They are never merged into one group; they are listed by node pair for review.",
  },
  // biomapper/harmonize/idcheck.py module docstring
  idCheck: {
    term: "Identifier check",
    text: "Each grouped row's declared identifiers compared with its node. Not confirmed means none of them is among the node's identifiers. It does not mean contradicted: the node may simply lack that cross-reference.",
  },
  // biomapper/cohorts.py module docstring (step 3) and CohortHarmonizationReport
  oneSided: {
    term: "One-sided identifier check",
    text: "A vocabulary only one cohort declares is not used for mapping. Each of its codes is resolved on its own and compared with the row's names-only result; every result other than agree is queued for a person to judge.",
  },
  // biomapper/models.py, ResolutionCertificate
  certificate: {
    term: "Certificate state",
    text: "What independent evidence says about the node chosen for a row: corroborated, uncorroborated, contradicted, unavailable or not applicable. Contradicted means a person should look, never that the resolver is wrong. Unavailable means there was nothing to check against: unverifiable rather than wrong.",
  },
  // biomapper/many_cohorts.py, where status is set
  status: {
    term: "Status",
    text: "ok when no row errored while mapping, partial when some rows errored, failed when every row errored.",
  },
  // many_cohorts.py module docstring
  grade: {
    term: "Grade",
    text: "A run that reused any saved mapping is iteration-grade, not for publication: reuse cannot detect engine changes on one knowledge graph build. Only a run that remapped every row on a verified build is publishable.",
  },
  // cohorts.py, read_cohort and harmonize_cohorts (a_key_column)
  keyColumn: {
    term: "Key column",
    text: "A column holding a unique value per row, used as the row's key. Blank or repeated keys are refused. Without one, a row's key is its row number and name.",
  },
  // cohorts.py, resolve_category, harmonize_cohorts (category) and name_linking_info
  category: {
    term: "Category override",
    text: "Sent instead of the category the entity type resolves to. It must be a Biolink category (biolink: and a name). The category also decides whether name links are on.",
  },
} as const;

export type GlossaryKey = keyof typeof GLOSSARY;

/** "What these terms mean": an expandable list of the package terms a stage uses. */
export function Glossary({ terms, className }: { terms: GlossaryKey[]; className?: string }) {
  return (
    <details className={cn("rounded border border-neutral-200 bg-white", className)} data-testid="glossary">
      <summary className="cursor-pointer px-4 py-2 text-sm font-medium text-neutral-900">What these terms mean</summary>
      <dl className="space-y-2 px-4 pb-3 text-sm">
        {terms.map((k) => (
          <div key={k}>
            <dt className="font-medium text-neutral-900">{GLOSSARY[k].term}</dt>
            <dd className="text-neutral-700">{GLOSSARY[k].text}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
