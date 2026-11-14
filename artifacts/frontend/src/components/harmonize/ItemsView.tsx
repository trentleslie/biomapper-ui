import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Flag, FlagOff, Loader2, RotateCcw, SlidersHorizontal } from "lucide-react";
import {
  bulkHarmonizeFlags,
  getListHarmonizeItemsQueryKey,
  resetHarmonizeFlags,
  setHarmonizeFlags,
  useListHarmonizeItems,
  type HarmonizeArm,
  type HarmonizeItem,
  type HarmonizeItemKind,
  type ListHarmonizeItemsParams,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { ITEM_KIND_LABELS, apiErrorMessage, armLabel, describeItem, plural } from "@/lib/harmonize";
import { EmptyState, ErrorBox, NativeSelect, SkeletonRows, ToneBadge } from "./primitives";

export const EITL_PREVIEW_KEY = (jobId: string) => ["harmonize-eitl-preview", jobId] as const;

export interface ItemFilters {
  kind: HarmonizeItemKind | "";
  arm: HarmonizeArm | "";
  flagged: "" | "true" | "false";
}

export const NO_FILTERS: ItemFilters = { kind: "", arm: "", flagged: "" };

/** A short accessible name for an item: what it is and its first rows' names. */
export function itemName(item: HarmonizeItem): string {
  const names = item.members.slice(0, 2).map((m) => (m.name && m.name !== m.key ? `${m.name} (${m.key})` : m.key));
  const more = item.members.length > 2 ? ` and ${item.members.length - 2} more` : "";
  return `${describeItem(item).title}, ${armLabel(item.arm).toLowerCase()} arm: ${names.join(" / ") || "no rows"}${more}`;
}

function memberText(m: HarmonizeItem["members"][number]): string {
  return `${m.cohort}: ${m.name ?? m.key} (${m.key})`;
}

/** The effective flag and its source after setting `flagged` on an item (the server's own rule). */
export function afterFlag(item: HarmonizeItem, flagged: boolean): HarmonizeItem {
  return { ...item, flagged, source: flagged === item.suggested ? "biomapper" : "organizer" };
}

/** Flag, de-flag, bulk and reset, each refreshing the list and the EITL preview. */
export function useFlagActions(jobId: string) {
  const queryClient = useQueryClient();
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: getListHarmonizeItemsQueryKey(jobId) });
    await queryClient.invalidateQueries({ queryKey: EITL_PREVIEW_KEY(jobId) });
  };
  return {
    async set(refs: string[], flagged: boolean) {
      const res = await setHarmonizeFlags(jobId, { refs, flagged });
      await refresh();
      return res;
    },
    async bulk(filter: { kind?: HarmonizeItemKind; arm?: HarmonizeArm; basis?: string; ambiguous?: boolean }, flagged: boolean) {
      const res = await bulkHarmonizeFlags(jobId, { filter, flagged });
      await refresh();
      return res;
    },
    async reset(refs?: string[]) {
      const res = await resetHarmonizeFlags(jobId, refs ? { refs } : undefined);
      await refresh();
      return res;
    },
  };
}

// ---------------------------------------------------------------------------
// Bulk flag dialog
// ---------------------------------------------------------------------------

function BulkDialog({
  open,
  onOpenChange,
  jobId,
  kinds,
  armsAvailable,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  jobId: string;
  kinds: HarmonizeItemKind[];
  armsAvailable: HarmonizeArm[];
  onDone: (message: string) => void;
}) {
  const actions = useFlagActions(jobId);
  const [kind, setKind] = useState<HarmonizeItemKind | "">("");
  const [arm, setArm] = useState<HarmonizeArm | "">("");
  const [basis, setBasis] = useState("");
  const [ambiguous, setAmbiguous] = useState<"" | "true" | "false">("");
  const [busy, setBusy] = useState<boolean | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setResult(null);
      setError(null);
    }
  }, [open]);

  async function apply(flagged: boolean) {
    setBusy(flagged);
    setError(null);
    setResult(null);
    const filter: { kind?: HarmonizeItemKind; arm?: HarmonizeArm; basis?: string; ambiguous?: boolean } = {};
    if (kind) filter.kind = kind;
    if (arm) filter.arm = arm;
    if (basis) filter.basis = basis;
    if (ambiguous) filter.ambiguous = ambiguous === "true";
    try {
      const res = await actions.bulk(filter, flagged);
      const msg = `${plural(res.updated, "item")} matched and ${res.updated === 1 ? "was" : "were"} ${flagged ? "flagged" : "de-flagged"}. ${plural(res.flaggedTotal, "item")} flagged in this run.`;
      setResult(msg);
      onDone(msg);
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Flag or de-flag in bulk</DialogTitle>
          <DialogDescription>Every item that matches all the fields you set is changed. Leave a field on Any to ignore it.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <NativeSelect id="bulk-kind" label="Kind" value={kind} onChange={(e) => setKind(e.target.value as HarmonizeItemKind | "")}>
            <option value="">Any kind</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {ITEM_KIND_LABELS[k]}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect id="bulk-arm" label="Arm" value={arm} onChange={(e) => setArm(e.target.value as HarmonizeArm | "")}>
            <option value="">Any arm</option>
            {armsAvailable.map((a) => (
              <option key={a} value={a}>
                {armLabel(a)}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect id="bulk-basis" label="Link basis" value={basis} onChange={(e) => setBasis(e.target.value)}>
            <option value="">Any basis</option>
            <option value="node">Same node (node)</option>
            <option value="identifier">Shared identifier (identifier)</option>
            <option value="name_exact">Same name (name_exact)</option>
            <option value="name_casefold">Same name ignoring case (name_casefold)</option>
          </NativeSelect>
          <NativeSelect id="bulk-ambiguous" label="Ambiguous" value={ambiguous} onChange={(e) => setAmbiguous(e.target.value as "" | "true" | "false")}>
            <option value="">Any</option>
            <option value="true">Ambiguous only</option>
            <option value="false">Not ambiguous only</option>
          </NativeSelect>
        </div>
        <p className="text-xs text-neutral-500">Basis and ambiguous apply to links only: setting either one matches links and nothing else.</p>
        {result && (
          <p role="status" className="rounded border border-success-border bg-success-bg p-2 text-sm text-success" data-testid="bulk-result">
            {result}
          </p>
        )}
        {error && <ErrorBox title="Nothing was changed" message={error} />}
        <DialogFooter className="gap-2">
          <Button variant="secondary" disabled={busy !== null} onClick={() => void apply(false)}>
            {busy === false ? <Loader2 aria-hidden className="animate-spin" /> : <FlagOff aria-hidden />}
            De-flag matching items
          </Button>
          <Button disabled={busy !== null} onClick={() => void apply(true)}>
            {busy === true ? <Loader2 aria-hidden className="animate-spin" /> : <Flag aria-hidden />}
            Flag matching items
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// The flag toggle of one row
// ---------------------------------------------------------------------------

export function FlagToggle({
  item,
  name,
  busy,
  onToggle,
  size = "row",
}: {
  item: HarmonizeItem;
  name: string;
  busy: boolean;
  onToggle: () => void;
  size?: "row" | "panel";
}) {
  return (
    <button
      type="button"
      aria-pressed={item.flagged}
      aria-label={`Flag ${name}`}
      title={item.flagged ? "Flagged. Click to de-flag." : "Not flagged. Click to flag."}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={cn(
        "inline-flex items-center gap-1 rounded border font-medium transition-colors disabled:opacity-50",
        size === "row" ? "h-7 px-2 text-xs" : "h-9 px-3 text-sm",
        item.flagged ? "border-ph-crimson bg-ph-crimson text-white hover:bg-ph-crimson-dark" : "border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50",
      )}
    >
      {busy ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <Flag aria-hidden className="h-3.5 w-3.5" />}
      {item.flagged ? "Flagged" : "Flag"}
    </button>
  );
}

export function SourceText({ item }: { item: HarmonizeItem }) {
  return item.source === "organizer" ? (
    <ToneBadge tone="info">organizer</ToneBadge>
  ) : (
    <ToneBadge tone="neutral">biomapper</ToneBadge>
  );
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

const PAGE_SIZES = [100, 250, 500, 1000];

export function ItemsView({
  jobId,
  kinds,
  armsAvailable,
  filters,
  setFilters,
  selectedRef,
  onOpen,
  onItemsChanged,
}: {
  jobId: string;
  kinds: HarmonizeItemKind[];
  armsAvailable: HarmonizeArm[];
  filters: ItemFilters;
  setFilters: (f: ItemFilters) => void;
  selectedRef: string | null;
  onOpen: (item: HarmonizeItem, siblings: HarmonizeItem[]) => void;
  onItemsChanged: (items: HarmonizeItem[]) => void;
}) {
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(100);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busyRefs, setBusyRefs] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actions = useFlagActions(jobId);
  const scrollRef = useRef<HTMLDivElement>(null);

  const params: ListHarmonizeItemsParams = useMemo(() => {
    const p: ListHarmonizeItemsParams = { offset, limit };
    if (filters.kind) p.kind = filters.kind;
    if (filters.arm) p.arm = filters.arm;
    if (filters.flagged) p.flagged = filters.flagged === "true";
    return p;
  }, [filters, offset, limit]);

  const q = useListHarmonizeItems(jobId, params, {
    query: { queryKey: getListHarmonizeItemsQueryKey(jobId, params), placeholderData: (prev) => prev },
  });
  const items = q.data?.items ?? [];
  const total = q.data?.total ?? 0;
  const flaggedTotal = q.data?.flaggedTotal ?? 0;

  useEffect(() => {
    onItemsChanged(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data]);

  // A new filter or page size starts at the first page, with nothing ticked.
  useEffect(() => {
    setOffset(0);
    setChecked(new Set());
  }, [filters, limit, jobId]);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [offset]);

  async function toggle(item: HarmonizeItem) {
    setBusyRefs((s) => new Set(s).add(item.ref));
    setError(null);
    try {
      const res = await actions.set([item.ref], !item.flagged);
      setMessage(`${item.flagged ? "De-flagged" : "Flagged"} 1 item. ${plural(res.flaggedTotal, "item")} flagged in this run.`);
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusyRefs((s) => {
        const n = new Set(s);
        n.delete(item.ref);
        return n;
      });
    }
  }

  async function onChecked(kind: "flag" | "deflag" | "reset") {
    const refs = [...checked];
    if (refs.length === 0) return;
    setError(null);
    setBusyRefs(new Set(refs));
    try {
      if (kind === "reset") {
        const res = await actions.reset(refs);
        setMessage(`Reset ${plural(refs.length, "item")} to biomapper's suggestion. ${plural(res.flaggedTotal, "item")} flagged in this run.`);
      } else {
        const res = await actions.set(refs, kind === "flag");
        setMessage(`${kind === "flag" ? "Flagged" : "De-flagged"} ${plural(res.updated, "item")}. ${plural(res.flaggedTotal, "item")} flagged in this run.`);
      }
      setChecked(new Set());
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusyRefs(new Set());
    }
  }

  async function resetAll() {
    setError(null);
    try {
      const res = await actions.reset();
      setMessage(`Every flag is back to biomapper's suggestion. ${plural(res.flaggedTotal, "item")} flagged in this run.`);
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }

  const allChecked = items.length > 0 && items.every((i) => checked.has(i.ref));
  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(offset + items.length, total);
  const filtered = filters.kind || filters.arm || filters.flagged;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-neutral-200 px-3 py-2">
        <NativeSelect inline id="filter-kind" label="Kind" value={filters.kind} onChange={(e) => setFilters({ ...filters, kind: e.target.value as ItemFilters["kind"] })}>
          <option value="">All kinds</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {ITEM_KIND_LABELS[k]}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect inline id="filter-arm" label="Arm" value={filters.arm} onChange={(e) => setFilters({ ...filters, arm: e.target.value as ItemFilters["arm"] })}>
          <option value="">Both arms</option>
          {armsAvailable.map((a) => (
            <option key={a} value={a}>
              {armLabel(a)}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect inline id="filter-flagged" label="Flag state" value={filters.flagged} onChange={(e) => setFilters({ ...filters, flagged: e.target.value as ItemFilters["flagged"] })}>
          <option value="">Flagged and not flagged</option>
          <option value="true">Flagged only</option>
          <option value="false">Not flagged only</option>
        </NativeSelect>
        {filtered && (
          <Button variant="ghost" size="sm" onClick={() => setFilters(NO_FILTERS)}>
            Clear filters
          </Button>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setBulkOpen(true)}>
            <SlidersHorizontal aria-hidden /> Bulk flag
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setResetOpen(true)}>
            <RotateCcw aria-hidden /> Reset all flags
          </Button>
        </div>
      </div>

      {/* Counts, selection actions and the result of the last action */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-neutral-100 bg-neutral-50 px-3 py-1.5 text-xs text-neutral-700">
        {q.data ? (
          <>
            <span data-testid="items-total">
              <span className="tabular font-semibold text-neutral-900">{total.toLocaleString()}</span> {total === 1 ? "item" : "items"}
              {filtered ? " match the filters" : " in this run"}
            </span>
            <span data-testid="flagged-total">
              <span className="tabular font-semibold text-ph-crimson">{flaggedTotal.toLocaleString()}</span> flagged in this run
            </span>
          </>
        ) : (
          <span>{q.isError ? "Items unavailable" : "Loading items"}</span>
        )}
        {checked.size > 0 && (
          <span className="flex flex-wrap items-center gap-1">
            <span className="font-medium">{checked.size} ticked:</span>
            <Button size="sm" variant="secondary" className="h-6 px-2" onClick={() => void onChecked("flag")}>
              Flag
            </Button>
            <Button size="sm" variant="secondary" className="h-6 px-2" onClick={() => void onChecked("deflag")}>
              De-flag
            </Button>
            <Button size="sm" variant="secondary" className="h-6 px-2" onClick={() => void onChecked("reset")}>
              Reset to suggestion
            </Button>
          </span>
        )}
        <span role="status" aria-live="polite" className="ml-auto text-neutral-600" data-testid="flag-message">
          {message}
        </span>
      </div>
      {error && <ErrorBox className="m-2" title="The flags were not changed" message={error} />}

      {/* The table */}
      <div ref={scrollRef} data-testid="items-scroll" className="min-h-0 flex-1 scroll-visible">
        {q.isLoading ? (
          <SkeletonRows rows={8} />
        ) : q.isError ? (
          <div className="p-3">
            <ErrorBox title="Could not load the items" message={apiErrorMessage(q.error)} onRetry={() => void q.refetch()} />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            title={filtered ? "No items match these filters" : "This run has no items"}
            description={filtered ? "Change or clear the filters to see more." : "Nothing was linked, grouped, queued for review or left unresolved."}
            action={filtered ? <Button variant="secondary" size="sm" onClick={() => setFilters(NO_FILTERS)}>Clear filters</Button> : undefined}
          />
        ) : (
          <table className="w-full text-sm" data-testid="items-table" aria-busy={q.isFetching}>
            <thead className="sticky top-0 z-10 bg-neutral-50 shadow-[inset_0_-1px_0_var(--color-neutral-200)]">
              <tr className="text-left text-[11px] font-medium uppercase tracking-wider text-neutral-500">
                <th className="w-8 px-2 py-2">
                  <input
                    type="checkbox"
                    aria-label="Tick every item on this page"
                    checked={allChecked}
                    onChange={(e) => setChecked(e.target.checked ? new Set(items.map((i) => i.ref)) : new Set())}
                  />
                </th>
                <th className="px-2 py-2">Flag</th>
                <th className="px-2 py-2" title="Where the flag state came from, and biomapper's own suggestion">Flag source</th>
                <th className="px-2 py-2">Kind</th>
                <th className="px-2 py-2">Item</th>
                <th className="px-2 py-2">Arm</th>
                <th className="w-2/5 px-2 py-2">Members</th>
                <th className="px-2 py-2">Details</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const d = describeItem(item);
                const name = itemName(item);
                const selected = item.ref === selectedRef;
                return (
                  <tr
                    key={item.ref}
                    data-ref={item.ref}
                    data-testid="item-row"
                    onClick={() => onOpen(item, items)}
                    className={cn("cursor-pointer border-b border-neutral-100 align-top hover:bg-neutral-50", selected && "bg-info-bg/60 hover:bg-info-bg/60", checked.has(item.ref) && !selected && "bg-neutral-100")}
                  >
                    <td className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Tick ${name}`}
                        checked={checked.has(item.ref)}
                        onChange={(e) =>
                          setChecked((s) => {
                            const n = new Set(s);
                            if (e.target.checked) n.add(item.ref);
                            else n.delete(item.ref);
                            return n;
                          })
                        }
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <FlagToggle item={item} name={name} busy={busyRefs.has(item.ref)} onToggle={() => void toggle(item)} />
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      <SourceText item={item} />
                      <div className="mt-0.5 text-[11px] text-neutral-500">suggested: {item.suggested ? "flag" : "no flag"}</div>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-xs text-neutral-700">{ITEM_KIND_LABELS[item.kind]}</td>
                    <td className="px-2 py-1.5">
                      <div className="flex min-w-[9rem] max-w-[15rem] flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          className="flex flex-wrap items-center gap-1.5 text-left font-medium text-ph-navy hover:underline"
                          aria-label={`Open ${name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpen(item, items);
                          }}
                        >
                          {item.kind === "link" || item.kind === "group" ? null : d.title}
                          {d.badges.map((b) => (
                            <ToneBadge key={b.text} tone={b.tone}>
                              {b.text}
                            </ToneBadge>
                          ))}
                          {(item.kind === "link" || item.kind === "group") && d.badges.length === 0 && d.title}
                        </button>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-neutral-700">{armLabel(item.arm)}</td>
                    <td className="max-w-[22rem] px-2 py-1.5">
                      <ul className="space-y-0.5">
                        {item.members.slice(0, 3).map((m, i) => (
                          <li key={`${m.cohort}-${m.key}-${i}`} className="truncate whitespace-nowrap" title={memberText(m)}>
                            <span className="text-xs text-neutral-500">{m.cohort}</span>{" "}
                            <span className="text-neutral-900">{m.name ?? m.key}</span>{" "}
                            <span className="font-mono text-[11px] text-neutral-500">{m.key}</span>
                          </li>
                        ))}
                        {item.members.length > 3 && <li className="text-xs text-neutral-500">and {item.members.length - 3} more rows</li>}
                        {item.members.length === 0 && <li className="text-xs text-neutral-500">No member rows</li>}
                      </ul>
                    </td>
                    <td className="max-w-[18rem] px-2 py-1.5 text-xs text-neutral-700">
                      {d.facts.length ? d.facts.map((f) => <div key={f} className="truncate" title={f}>{f}</div>) : <span className="text-neutral-400">No further detail</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pager */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-neutral-200 py-1.5 pl-3 pr-16 text-xs text-neutral-700">
        <span data-testid="items-range">
          Showing {first.toLocaleString()} to {last.toLocaleString()} of {total.toLocaleString()}
        </span>
        <div className="flex items-center gap-2">
          <NativeSelect id="page-size" label="Rows per page" hideLabel value={String(limit)} onChange={(e) => setLimit(Number(e.target.value))}>
            {PAGE_SIZES.map((s) => (
              <option key={s} value={s}>
                {s} per page
              </option>
            ))}
          </NativeSelect>
          <Button variant="secondary" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))} aria-label="Previous page">
            <ChevronLeft aria-hidden />
          </Button>
          <Button variant="secondary" size="sm" disabled={offset + limit >= total} onClick={() => setOffset(offset + limit)} aria-label="Next page">
            <ChevronRight aria-hidden />
          </Button>
        </div>
      </div>

      <BulkDialog open={bulkOpen} onOpenChange={setBulkOpen} jobId={jobId} kinds={kinds} armsAvailable={armsAvailable} onDone={setMessage} />
      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset every flag?</AlertDialogTitle>
            <AlertDialogDescription>
              Every change you made to the flags of this run is dropped, and each item goes back to biomapper's suggestion.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep my flags</AlertDialogCancel>
            <AlertDialogAction onClick={() => void resetAll()}>Reset all flags</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
