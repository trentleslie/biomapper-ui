import { useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, RotateCcw, X } from "lucide-react";
import {
  getGetHarmonizeReviewItemQueryKey,
  getListHarmonizeReviewItemsQueryKey,
  useGetHarmonizeReviewItem,
  useListHarmonizeReviewItems,
  type HarmonizeItem,
  type HarmonizeReviewItemSummary,
  type HarmonizeSideDetail,
  type ListHarmonizeReviewItemsParams,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ITEM_KIND_LABELS, apiErrorMessage, armLabel, basisLabel, describeItem, originLabel } from "@/lib/harmonize";
import { EmptyState, ErrorBox, Mono, NativeSelect, SectionTitle, SkeletonRows, ToneBadge } from "./primitives";
import { FlagToggle, SourceText, afterFlag, useFlagActions } from "./ItemsView";

// ---------------------------------------------------------------------------
// The dock: a panel beside the table
// ---------------------------------------------------------------------------

export function Dock({ title, onClose, children, testId }: { title: string; onClose: () => void; children: ReactNode; testId?: string }) {
  return (
    <aside
      aria-label={title}
      data-testid={testId}
      className="flex w-[26rem] max-w-[45%] shrink-0 flex-col rounded border border-neutral-200 bg-white"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="flex items-center justify-between gap-2 border-b border-neutral-200 px-3 py-2">
        <h2 className="truncate text-sm font-semibold text-neutral-900">{title}</h2>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label={`Close ${title}`}>
          <X aria-hidden />
        </Button>
      </div>
      <div className="min-h-0 flex-1 scroll-visible p-3">{children}</div>
    </aside>
  );
}

/** Any report value as readable text: lists joined, nested maps one line per key. */
function Value({ value }: { value: unknown }): ReactNode {
  if (value === null || value === undefined || value === "") return <span className="text-neutral-400">None</span>;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return <span className="tabular">{value.toLocaleString()}</span>;
  if (typeof value === "string") return <span className="break-words">{value}</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-neutral-400">None</span>;
    if (value.every((v) => typeof v !== "object" || v === null)) {
      return <span className="break-words">{value.map(String).join(", ")}</span>;
    }
    return (
      <ul className="space-y-1">
        {value.map((v, i) => (
          <li key={i} className="rounded border border-neutral-100 p-1">
            <Value value={v} />
          </li>
        ))}
      </ul>
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className="text-neutral-400">None</span>;
    return (
      <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-2 gap-y-0.5">
        {entries.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-neutral-500">{humanKey(k)}</dt>
            <dd className="min-w-0">
              <Value value={v} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return String(value);
}

function humanKey(k: string): string {
  const spaced = k.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function Fields({ data, skip = [] }: { data: Record<string, unknown>; skip?: string[] }) {
  const entries = Object.entries(data).filter(([k]) => !skip.includes(k));
  if (entries.length === 0) return <p className="text-xs text-neutral-500">No further detail.</p>;
  return (
    <dl className="grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-neutral-500">{humanKey(k)}</dt>
          <dd className="min-w-0 text-neutral-900">
            <Value value={v} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// One item of the workbench: what it is, its rows, its flag
// ---------------------------------------------------------------------------

export function ItemPanel({
  jobId,
  item,
  onItemChange,
  onPrev,
  onNext,
  position,
  onClose,
}: {
  jobId: string;
  item: HarmonizeItem;
  onItemChange: (item: HarmonizeItem) => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  position: string | null;
  onClose: () => void;
}) {
  const actions = useFlagActions(jobId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = describeItem(item);
  const detail = item.detail as Record<string, unknown>;
  const name = `${d.title}, ${item.members.map((m) => `${m.cohort}: ${m.name ?? m.key}`).slice(0, 2).join("; ")}`;

  async function run(fn: () => Promise<unknown>, next: HarmonizeItem) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onItemChange(next);
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dock title="Item detail" onClose={onClose} testId="item-panel">
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <Button variant="secondary" size="sm" disabled={!onPrev} onClick={() => onPrev?.()} aria-label="Previous item">
            <ChevronLeft aria-hidden /> Previous
          </Button>
          {position && <span className="text-xs text-neutral-500">{position}</span>}
          <Button variant="secondary" size="sm" disabled={!onNext} onClick={() => onNext?.()} aria-label="Next item">
            Next <ChevronRight aria-hidden />
          </Button>
        </div>
        <div>
          <p className="text-base font-semibold text-neutral-900" data-testid="item-panel-title">
            {d.title}
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            <ToneBadge tone="neutral">{ITEM_KIND_LABELS[item.kind]}</ToneBadge>
            <ToneBadge tone="neutral">{armLabel(item.arm)} arm</ToneBadge>
            {d.badges.map((b) => (
              <ToneBadge key={b.text} tone={b.tone}>
                {b.text}
              </ToneBadge>
            ))}
          </div>
          {d.facts.length > 0 && <p className="mt-1 text-xs text-neutral-700">{d.facts.join(" · ")}</p>}
        </div>

        <div className="rounded border border-neutral-200 bg-neutral-50 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <FlagToggle item={item} name={name} busy={busy} size="panel" onToggle={() => void run(() => actions.set([item.ref], !item.flagged), afterFlag(item, !item.flagged))} />
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || item.source === "biomapper"}
              onClick={() => void run(() => actions.reset([item.ref]), { ...item, flagged: item.suggested, source: "biomapper" })}
            >
              <RotateCcw aria-hidden /> Back to suggestion
            </Button>
          </div>
          <p className="mt-2 flex items-center gap-1 text-xs text-neutral-700">
            Flag set by <SourceText item={item} /> · biomapper suggests {item.suggested ? "flagging" : "no flag"}
          </p>
          {error && <ErrorBox className="mt-2" title="The flag was not changed" message={error} />}
        </div>

        <section>
          <SectionTitle>Rows ({item.members.length})</SectionTitle>
          {item.members.length === 0 ? (
            <p className="text-xs text-neutral-500">This entry names no rows.</p>
          ) : (
            <div className="max-h-64 scroll-visible rounded border border-neutral-200">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-neutral-50 text-left text-[11px] uppercase tracking-wider text-neutral-500">
                  <tr>
                    <th className="px-2 py-1">Cohort</th>
                    <th className="px-2 py-1">Key</th>
                    <th className="px-2 py-1">Name</th>
                    <th className="px-2 py-1">Chosen node</th>
                  </tr>
                </thead>
                <tbody>
                  {item.members.map((m, i) => (
                    <tr key={`${m.cohort}-${m.key}-${i}`} className="border-t border-neutral-100">
                      <td className="px-2 py-1">{m.cohort}</td>
                      <td className="px-2 py-1">
                        <Mono>{m.key}</Mono>
                      </td>
                      <td className="px-2 py-1">{m.name ?? <span className="text-neutral-400">Not given</span>}</td>
                      <td className="px-2 py-1">{m.chosenKgId ? <Mono>{m.chosenKgId}</Mono> : <span className="text-neutral-400">None</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section>
          <SectionTitle>What biomapper reported</SectionTitle>
          <p className="mb-2 text-xs text-neutral-600">
            From {originLabel(detail.origin) || "the report"}
            {typeof detail.basis === "string" ? `, basis ${detail.basis} (${basisLabel(detail.basis)})` : ""}.
          </p>
          <Fields data={detail} skip={["origin"]} />
        </section>
        <p className="text-[11px] text-neutral-400">
          Reference <Mono>{item.ref}</Mono>
        </p>
      </div>
    </Dock>
  );
}

// ---------------------------------------------------------------------------
// The package's review queue (evidence captured for review)
// ---------------------------------------------------------------------------

export function ReviewQueueView({
  jobId,
  available,
  selectedRef,
  onOpen,
}: {
  jobId: string;
  available: boolean;
  selectedRef: string | null;
  onOpen: (ref: string) => void;
}) {
  const [kind, setKind] = useState<"" | "row" | "link">("");
  const [offset, setOffset] = useState(0);
  const limit = 50;
  const params: ListHarmonizeReviewItemsParams = { offset, limit, ...(kind ? { kind } : {}) };
  const q = useListHarmonizeReviewItems(jobId, params, {
    query: { queryKey: getListHarmonizeReviewItemsQueryKey(jobId, params), enabled: available, placeholderData: (p) => p },
  });

  if (!available) {
    return (
      <EmptyState
        title="No review queue for this run"
        description="This run harmonized two finished mapping jobs, so it has no review items: no evidence was captured. Its links and unresolved rows are in the Items view."
      />
    );
  }
  const items = q.data?.items ?? [];
  const total = q.data?.total ?? 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-end gap-3 border-b border-neutral-200 px-3 py-2">
        <NativeSelect id="review-kind" label="Kind" value={kind} onChange={(e) => { setKind(e.target.value as "" | "row" | "link"); setOffset(0); }}>
          <option value="">Rows and links</option>
          <option value="row">Rows</option>
          <option value="link">Links</option>
        </NativeSelect>
        <p className="pb-1 text-xs text-neutral-600">
          The evidence biomapper captured for review, highest impact first. Open an entry to see the engine's choice, certificates and the question to ask. Flags are set in the Items view.
        </p>
      </div>
      {q.data && (
        <div className="flex flex-wrap gap-x-4 border-b border-neutral-100 bg-neutral-50 px-3 py-1.5 text-xs text-neutral-700">
          <span>
            <span className="tabular font-semibold">{total}</span> entries
          </span>
          {Object.entries(q.data.counts ?? {}).map(([k, v]) => (
            <span key={k}>
              {k === "row" ? "Rows" : k === "link" ? "Links" : k}: <span className="tabular">{v}</span>
            </span>
          ))}
          {q.data.skippedNoNode > 0 && <span>Skipped, no node: {q.data.skippedNoNode}</span>}
          {q.data.note && <span className="text-neutral-500">{q.data.note}</span>}
        </div>
      )}
      <div className="min-h-0 flex-1 scroll-visible">
        {q.isLoading ? (
          <SkeletonRows rows={6} />
        ) : q.isError ? (
          <div className="p-3">
            <ErrorBox title="Could not load the review queue" message={apiErrorMessage(q.error)} onRetry={() => void q.refetch()} />
          </div>
        ) : items.length === 0 ? (
          <EmptyState title="Nothing in the review queue" description="biomapper captured no entries for review on this run." />
        ) : (
          <table className="w-full text-sm" data-testid="review-table">
            <thead className="sticky top-0 z-10 bg-neutral-50 shadow-[inset_0_-1px_0_var(--color-neutral-200)]">
              <tr className="text-left text-[11px] font-medium uppercase tracking-wider text-neutral-500">
                <th className="px-2 py-2 text-right">Impact</th>
                <th className="px-2 py-2">Entry</th>
                <th className="px-2 py-2">Reasons</th>
                <th className="px-2 py-2">Cohorts</th>
                <th className="px-2 py-2">Nodes</th>
                <th className="px-2 py-2">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it: HarmonizeReviewItemSummary) => (
                <tr
                  key={it.ref}
                  onClick={() => onOpen(it.ref)}
                  className={cn("cursor-pointer border-b border-neutral-100 align-top hover:bg-neutral-50", it.ref === selectedRef && "bg-info-bg/60")}
                >
                  <td className="tabular px-2 py-1.5 text-right">{it.impact}</td>
                  <td className="px-2 py-1.5">
                    <button
                      type="button"
                      className="text-left font-medium text-ph-navy hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpen(it.ref);
                      }}
                    >
                      {it.label || "Unnamed entry"}
                    </button>
                    <div className="mt-0.5">
                      <ToneBadge tone="neutral">{it.kind === "row" ? "Row" : "Link"}</ToneBadge>
                    </div>
                  </td>
                  <td className="px-2 py-1.5 text-xs">{it.reasons.join(", ").replace(/_/g, " ") || "None given"}</td>
                  <td className="px-2 py-1.5 text-xs">{it.cohorts.join(", ")}</td>
                  <td className="px-2 py-1.5 text-xs">
                    {it.nodes.length ? <Mono>{it.nodes.join(", ")}</Mono> : <span className="text-neutral-400">None</span>}
                  </td>
                  <td className="px-2 py-1.5 text-xs">{it.evidence.replace(/_/g, " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="flex items-center justify-between border-t border-neutral-200 px-3 py-1.5 text-xs text-neutral-700">
        <span>
          Showing {total === 0 ? 0 : offset + 1} to {Math.min(offset + items.length, total)} of {total}
        </span>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))} aria-label="Previous review page">
            <ChevronLeft aria-hidden />
          </Button>
          <Button variant="secondary" size="sm" disabled={q.data?.nextOffset == null} onClick={() => setOffset(q.data?.nextOffset ?? offset)} aria-label="Next review page">
            <ChevronRight aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  );
}

function Side({ title, side }: { title: string; side: HarmonizeSideDetail | undefined }) {
  if (!side) return null;
  return (
    <div className="rounded border border-neutral-200 p-2">
      <p className="text-xs font-semibold text-neutral-900">{title}</p>
      <dl className="mt-1 grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-xs">
        <dt className="text-neutral-500">Node</dt>
        <dd>{side.node ? <Mono>{side.node}</Mono> : "None"}</dd>
        <dt className="text-neutral-500">Node name</dt>
        <dd>{side.nodeName ?? <span className="text-neutral-400">{side.nodeNameStatus ? side.nodeNameStatus.replace(/_/g, " ") : "Not available"}</span>}</dd>
        <dt className="text-neutral-500">Rows</dt>
        <dd>
          {(side.rows ?? []).map((r) => `${r.cohort} ${r.key} ${r.name}`).join("; ") || "None"}
        </dd>
        <dt className="text-neutral-500">Identifiers</dt>
        <dd>
          <Value value={side.identifiers} />
        </dd>
        <dt className="text-neutral-500">Certificate states</dt>
        <dd>
          <Value value={side.certificateStates} />
        </dd>
      </dl>
    </div>
  );
}

export function ReviewItemPanel({ jobId, refId, onClose }: { jobId: string; refId: string; onClose: () => void }) {
  const q = useGetHarmonizeReviewItem(jobId, refId, { query: { queryKey: getGetHarmonizeReviewItemQueryKey(jobId, refId) } });
  const d = q.data;
  return (
    <Dock title="Review entry" onClose={onClose} testId="review-panel">
      {q.isLoading ? (
        <SkeletonRows rows={6} />
      ) : q.isError ? (
        <ErrorBox title="Could not load this entry" message={apiErrorMessage(q.error)} onRetry={() => void q.refetch()} />
      ) : !d ? null : (
        <div className="space-y-4 text-sm">
          <div>
            <p className="font-semibold text-neutral-900">{d.kind === "row" ? "Row entry" : "Link entry"}</p>
            <p className="text-xs text-neutral-600">Impact {d.impact}</p>
          </div>
          {d.row && (
            <section className="space-y-2" data-testid="review-row-detail">
              <SectionTitle>Row</SectionTitle>
              <dl className="grid grid-cols-[minmax(8rem,auto)_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
                <dt className="text-neutral-500">Name</dt>
                <dd>{d.row.name ?? "Not given"}</dd>
                <dt className="text-neutral-500">Engine's choice</dt>
                <dd>{d.row.engineChoice ? <Mono>{d.row.engineChoice}</Mono> : "None"}</dd>
                <dt className="text-neutral-500">Certificate state</dt>
                <dd>{d.row.certificateState ?? "None"}</dd>
                <dt className="text-neutral-500">Candidates status</dt>
                <dd>{d.row.candidatesStatus ?? "Not reported"}</dd>
                <dt className="text-neutral-500">Candidates reason</dt>
                <dd>{d.row.candidatesReason ?? "None given"}</dd>
                <dt className="text-neutral-500">Category</dt>
                <dd>{d.row.category ?? "Not reported"}</dd>
                {d.row.weakTrigger && (
                  <>
                    <dt className="text-neutral-500">Weak because</dt>
                    <dd>{d.row.weakTrigger}</dd>
                  </>
                )}
                <dt className="text-neutral-500">Rows</dt>
                <dd>{(d.row.rows ?? []).map((r) => `${r.cohort} ${r.key} ${r.name}`).join("; ") || "None"}</dd>
                {d.row.supersedingRef && (
                  <>
                    <dt className="text-neutral-500">Superseded by</dt>
                    <dd>
                      <Mono>{d.row.supersedingRef}</Mono>
                    </dd>
                  </>
                )}
              </dl>
            </section>
          )}
          {d.link && (
            <section className="space-y-2" data-testid="review-link-detail">
              <SectionTitle>Link</SectionTitle>
              {d.link.question && <p className="rounded border border-info-border bg-info-bg p-2 text-xs text-neutral-900">Question to ask: {d.link.question}</p>}
              <dl className="grid grid-cols-[minmax(8rem,auto)_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
                <dt className="text-neutral-500">Link kind</dt>
                <dd>{d.link.linkKind ?? "Not reported"}</dd>
                <dt className="text-neutral-500">Basis</dt>
                <dd>{d.link.basis ? `${d.link.basis} (${basisLabel(d.link.basis)})` : "None"}</dd>
                <dt className="text-neutral-500">All bases</dt>
                <dd>{(d.link.bases ?? []).join(", ") || "None"}</dd>
                <dt className="text-neutral-500">Review reasons</dt>
                <dd>{(d.link.reviewReasons ?? []).join(", ") || "None"}</dd>
                <dt className="text-neutral-500">Row pairs</dt>
                <dd>{d.link.nRowPairs ?? "Not reported"}</dd>
              </dl>
              <Side title="Side A" side={d.link.a} />
              <Side title="Side B" side={d.link.b} />
            </section>
          )}
          {d.suggestion && <p className="text-xs text-neutral-700">Suggestion: {d.suggestion}</p>}
          {d.nextStep && <p className="text-xs text-neutral-700">Next step: {d.nextStep}</p>}
          {d.note && <p className="text-xs text-neutral-500">{d.note}</p>}
          <p className="text-[11px] text-neutral-400">
            Reference <Mono>{d.ref}</Mono>
          </p>
        </div>
      )}
    </Dock>
  );
}
