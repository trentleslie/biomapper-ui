import { useEffect, useState } from "react";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Loader2, RotateCcw } from "lucide-react";
import {
  bulkHarmonizeFlags,
  getListHarmonizeItemsQueryKey,
  resetHarmonizeFlags,
  setHarmonizeFlags,
  useListHarmonizeItems,
  type HarmonizeArm,
  type HarmonizeFlagFilter,
  type HarmonizeItem,
  type HarmonizeItemKind,
  type ListHarmonizeItemsParams,
} from "@workspace/api-client-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { ITEM_KIND_LABEL, armLabel, errorMessage, humanize, itemSummary, originLabel, plural } from "@/lib/harmonize";
import { EmptyState, ErrorPanel, LoadingBlock, Mono, Note, Pager, Panel, Untrusted } from "./common";

const PAGE = 100;
const ANY = "any";

/** Every query that depends on this run's flags: the item pages (all filters) and the EITL preview. */
export async function invalidateFlagQueries(queryClient: ReturnType<typeof useQueryClient>, jobId: string) {
  const itemsKey = getListHarmonizeItemsQueryKey(jobId)[0];
  await Promise.all([
    queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === itemsKey }),
    queryClient.invalidateQueries({ queryKey: ["harmonize-eitl-preview", jobId] }),
  ]);
}

function FilterSelect({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} aria-label={label} className="h-8 w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([v, l]) => (
            <SelectItem key={v} value={v}>
              {l}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

const KIND_OPTIONS: [string, string][] = [
  [ANY, "Any kind"],
  ["link", "Links"],
  ["group", "Groups"],
  ["review", "Review entries"],
  ["unresolved", "Unresolved rows"],
];
const ARM_OPTIONS: [string, string][] = [
  [ANY, "Both arms"],
  ["names_only", "Names-only arm"],
  ["identifier", "Identifier arm"],
];

function membersText(item: HarmonizeItem): string {
  return item.members.map((m) => `${m.cohort} ${m.key}${m.name ? ` ${m.name}` : ""}`).join(", ");
}

function SourceBadge({ source }: { source: string }) {
  return source === "organizer" ? (
    <Badge variant="info">Organizer</Badge>
  ) : (
    <Badge variant="neutral">biomapper</Badge>
  );
}

function ItemDetailSheet({ item, onClose }: { item: HarmonizeItem | null; onClose: () => void }) {
  return (
    <Sheet open={!!item} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto scroll-visible sm:max-w-xl">
        {item && (
          <>
            <SheetHeader>
              <SheetTitle>
                {ITEM_KIND_LABEL[item.kind] ?? item.kind}: {armLabel(item.arm)}
              </SheetTitle>
              <SheetDescription>{itemSummary(item.kind, item.detail).join(", ") || originLabel(item.detail.origin)}</SheetDescription>
            </SheetHeader>
            <div className="mt-4 space-y-4 text-sm" data-testid="item-detail">
              <p>
                {item.flagged ? <Badge variant="warning">Flagged</Badge> : <Badge variant="neutral">Not flagged</Badge>}{" "}
                <span className="ml-1 text-xs text-neutral-500">
                  Flag state from <SourceBadge source={item.source} />. biomapper {item.suggested ? "suggests flagging it" : "does not suggest flagging it"}.
                </span>
              </p>
              <section>
                <h3 className="mb-1 text-xs font-medium uppercase tracking-wider text-neutral-500">Members ({item.members.length})</h3>
                <div className="scroll-visible max-h-64 rounded border border-neutral-200">
                  <table className="w-full text-sm">
                    <caption className="sr-only">Members</caption>
                    <thead className="sticky top-0 bg-neutral-50">
                      <tr>
                        {["Cohort", "Key", "Name", "Node"].map((h) => (
                          <th key={h} scope="col" className="px-3 py-1.5 text-left text-xs font-medium uppercase tracking-wider text-neutral-500">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {item.members.map((m, i) => (
                        <tr key={i} className="border-t border-neutral-100">
                          <td className="px-3 py-1.5">{m.cohort}</td>
                          <td className="px-3 py-1.5"><Mono>{m.key}</Mono></td>
                          <td className="px-3 py-1.5"><Untrusted value={m.name} /></td>
                          <td className="px-3 py-1.5"><Mono>{m.chosenKgId ?? "No node"}</Mono></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
              <section>
                <h3 className="mb-1 text-xs font-medium uppercase tracking-wider text-neutral-500">What the report says</h3>
                <dl className="space-y-1.5">
                  {Object.entries(item.detail)
                    .filter(([k]) => k !== "sharedIdentifiers")
                    .map(([k, v]) => (
                      <div key={k} className="grid grid-cols-[10rem_1fr] gap-2">
                        <dt className="text-xs text-neutral-500">{humanize(k.replace(/([A-Z])/g, "_$1").toLowerCase())}</dt>
                        <dd className="text-neutral-900 [overflow-wrap:anywhere]">
                          {k === "origin" ? originLabel(v) : typeof v === "object" && v !== null ? <Mono>{JSON.stringify(v)}</Mono> : v === "" ? <span className="text-neutral-400">Blank</span> : String(v)}
                        </dd>
                      </div>
                    ))}
                </dl>
                {Array.isArray(item.detail.sharedIdentifiers) && item.detail.sharedIdentifiers.length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-neutral-600">
                      Shared identifiers ({item.detail.sharedIdentifiers.length})
                    </summary>
                    <div className="scroll-visible mt-1 max-h-40 rounded border border-neutral-100 p-2">
                      <Mono>{(item.detail.sharedIdentifiers as string[]).join(", ")}</Mono>
                    </div>
                  </details>
                )}
              </section>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

/**
 * Flagging: every item of the run with its flag state and where that came from, filters, paging, one-item and
 * bulk flagging, and reset to biomapper's suggestion. Flags are stored on the server per run and user.
 */
export function FlagItemsView({ jobId, kind }: { jobId: string; kind: string }) {
  const queryClient = useQueryClient();
  const [kindFilter, setKindFilter] = useState(ANY);
  const [armFilter, setArmFilter] = useState(ANY);
  const [flagFilter, setFlagFilter] = useState(ANY);
  const [offset, setOffset] = useState(0);
  const [pendingRefs, setPendingRefs] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [lastChange, setLastChange] = useState<string | null>(null);
  const [openItem, setOpenItem] = useState<HarmonizeItem | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const params: ListHarmonizeItemsParams = {
    ...(kindFilter !== ANY && { kind: kindFilter as HarmonizeItemKind }),
    ...(armFilter !== ANY && { arm: armFilter as HarmonizeArm }),
    ...(flagFilter !== ANY && { flagged: flagFilter === "yes" }),
    offset,
    limit: PAGE,
  };
  const q = useListHarmonizeItems(jobId, params, {
    query: { queryKey: getListHarmonizeItemsQueryKey(jobId, params), placeholderData: keepPreviousData },
  });

  const setFilter = (setter: (v: string) => void) => (v: string) => {
    setter(v);
    setOffset(0);
  };

  const toggle = async (item: HarmonizeItem, flagged: boolean) => {
    setActionError(null);
    setPendingRefs((p) => new Set(p).add(item.ref));
    try {
      const res = await setHarmonizeFlags(jobId, { refs: [item.ref], flagged });
      setLastChange(`${flagged ? "Flagged" : "De-flagged"} one ${ITEM_KIND_LABEL[item.kind]?.toLowerCase() ?? "item"}. ${plural(res.flaggedTotal, "item")} flagged in this run.`);
      await invalidateFlagQueries(queryClient, jobId);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setPendingRefs((p) => {
        const n = new Set(p);
        n.delete(item.ref);
        return n;
      });
    }
  };

  const resetOne = async (item: HarmonizeItem) => {
    setActionError(null);
    setPendingRefs((p) => new Set(p).add(item.ref));
    try {
      const res = await resetHarmonizeFlags(jobId, { refs: [item.ref] });
      setLastChange(`Reset one item to biomapper's suggestion. ${plural(res.flaggedTotal, "item")} flagged in this run.`);
      await invalidateFlagQueries(queryClient, jobId);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setPendingRefs((p) => {
        const n = new Set(p);
        n.delete(item.ref);
        return n;
      });
    }
  };

  const resetAll = async () => {
    setActionError(null);
    try {
      const res = await resetHarmonizeFlags(jobId, {});
      setLastChange(`Every flag is back to biomapper's suggestion. ${plural(res.flaggedTotal, "item")} flagged in this run.`);
      setOffset(0);
      await invalidateFlagQueries(queryClient, jobId);
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  const data = q.data;
  // A change can leave the current page past the end (for example de-flagging the last row of the last page
  // while showing flagged items only). Step back to the last page that has rows.
  const total = data?.total;
  useEffect(() => {
    if (total != null && offset > 0 && offset >= total) setOffset(Math.max(0, Math.floor((total - 1) / PAGE) * PAGE));
  }, [total, offset]);

  return (
    <div className="space-y-6">
      <Panel
        id="flag-items"
        title="Flag items for expert review"
        description="biomapper has already flagged every review entry, every ambiguous link and every group with multiplicity. Flag or clear any item; your choice shows as Organizer."
        actions={
          <Button variant="secondary" size="sm" onClick={() => setConfirmReset(true)}>
            <RotateCcw aria-hidden /> Reset all flags
          </Button>
        }
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-4" role="group" aria-label="Filter items">
            <FilterSelect id="f-kind" label="Kind" value={kindFilter} onChange={setFilter(setKindFilter)} options={KIND_OPTIONS} />
            <FilterSelect id="f-arm" label="Arm" value={armFilter} onChange={setFilter(setArmFilter)} options={ARM_OPTIONS} />
            <FilterSelect
              id="f-flag"
              label="Flag state"
              value={flagFilter}
              onChange={setFilter(setFlagFilter)}
              options={[
                [ANY, "Flagged or not"],
                ["yes", "Flagged"],
                ["no", "Not flagged"],
              ]}
            />
            {data && (
              <p className="ml-auto text-sm text-neutral-700" data-testid="item-totals" aria-live="polite">
                <span className="font-semibold tabular-nums">{data.total.toLocaleString()}</span> {data.total === 1 ? "item" : "items"}
                {(kindFilter !== ANY || armFilter !== ANY || flagFilter !== ANY) && " match these filters"}
                {", "}
                <span className="font-semibold tabular-nums">{data.flaggedTotal.toLocaleString()}</span> flagged in this run
              </p>
            )}
          </div>

          {lastChange && (
            <p role="status" className="rounded border border-success-border bg-success-bg px-3 py-2 text-sm text-success" data-testid="flag-change">
              {lastChange}
            </p>
          )}
          {actionError && (
            <Note tone="danger" title="The flag did not change">
              {actionError}
            </Note>
          )}

          {q.isLoading ? (
            <LoadingBlock lines={6} label="Loading items" />
          ) : q.isError ? (
            <ErrorPanel title="The items did not load" message={errorMessage(q.error)} onRetry={() => q.refetch()} />
          ) : !data || data.items.length === 0 ? (
            <EmptyState
              compact
              title={data && data.total === 0 && kindFilter === ANY && armFilter === ANY && flagFilter === ANY ? "This run has no items" : "No items match these filters"}
              description="Change the filters above to see other items."
            />
          ) : (
            <>
              <div className={cn("scroll-visible max-h-[32rem] rounded border border-neutral-200", q.isFetching && "opacity-80")} data-testid="items-table">
                <table className="w-full text-sm">
                  <caption className="sr-only">Items of this run</caption>
                  <thead className="sticky top-0 z-10 bg-neutral-50">
                    <tr className="border-b border-neutral-200">
                      {["Flag", "Kind", "Arm", "Members", "What it is", "Flag from", ""].map((h, i) => (
                        <th key={i} scope="col" className="whitespace-nowrap px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-neutral-500">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((item) => {
                      const pending = pendingRefs.has(item.ref);
                      const desc = membersText(item);
                      return (
                        <tr key={item.ref} className={cn("border-b border-neutral-100", item.flagged && "bg-warning-bg/40")} data-testid="item-row">
                          <td className="px-3 py-2 align-top">
                            <div className="flex items-center gap-2">
                              <Checkbox
                                checked={item.flagged}
                                disabled={pending}
                                onCheckedChange={(v) => toggle(item, v === true)}
                                aria-label={`${item.flagged ? "Flagged" : "Flag"}: ${ITEM_KIND_LABEL[item.kind] ?? item.kind}, ${desc}`}
                              />
                              {pending && <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin text-neutral-400 motion-reduce:animate-none" />}
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 align-top">{ITEM_KIND_LABEL[item.kind] ?? item.kind}</td>
                          <td className="whitespace-nowrap px-3 py-2 align-top">{armLabel(item.arm)}</td>
                          <td className="px-3 py-2 align-top">
                            <div className="space-y-0.5">
                              {item.members.slice(0, 4).map((m, i) => (
                                <div key={i} className="whitespace-nowrap">
                                  <span className="text-neutral-500">{m.cohort}</span> <Mono>{m.key}</Mono> <Untrusted value={m.name} />
                                </div>
                              ))}
                              {item.members.length > 4 && <div className="text-xs text-neutral-500">and {item.members.length - 4} more</div>}
                            </div>
                          </td>
                          <td className="px-3 py-2 align-top text-neutral-700">
                            <div className="flex flex-wrap gap-1">
                              {itemSummary(item.kind, item.detail).map((s, i) => (
                                <span key={i} className="whitespace-nowrap rounded bg-neutral-100 px-1.5 py-0.5 text-xs">{s}</span>
                              ))}
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 align-top">
                            <SourceBadge source={item.source} />
                            <span className="block pt-0.5 text-xs text-neutral-500">Suggested: {item.suggested ? "flag" : "no flag"}</span>
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-right align-top">
                            {item.source === "organizer" && (
                              <Button size="sm" variant="ghost" disabled={pending} onClick={() => resetOne(item)} aria-label={`Reset to biomapper's suggestion: ${desc}`}>
                                <RotateCcw aria-hidden /> Reset
                              </Button>
                            )}
                            <Button size="sm" variant="ghost" onClick={() => setOpenItem(item)} aria-label={`Details: ${ITEM_KIND_LABEL[item.kind] ?? item.kind}, ${desc}`}>
                              Details <ChevronRight aria-hidden />
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Pager offset={offset} pageSize={PAGE} total={data.total} onOffset={setOffset} noun="items" />
            </>
          )}
        </div>
      </Panel>

      <BulkFlagPanel
        jobId={jobId}
        kind={kind}
        onChanged={(msg) => {
          setLastChange(msg);
          setOffset(0);
        }}
      />

      <ItemDetailSheet item={openItem} onClose={() => setOpenItem(null)} />

      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset every flag?</AlertDialogTitle>
            <AlertDialogDescription>
              Every item goes back to biomapper's suggestion and your own flags and clears are removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep my flags</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmReset(false);
                void resetAll();
              }}
            >
              Reset all flags
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const BASES: [string, string][] = [
  [ANY, "Any basis"],
  ["node", "node"],
  ["identifier", "identifier"],
  ["name_exact", "name_exact"],
  ["name_casefold", "name_casefold"],
];

function BulkFlagPanel({ jobId, kind, onChanged }: { jobId: string; kind: string; onChanged: (msg: string) => void }) {
  const queryClient = useQueryClient();
  const [bKind, setBKind] = useState(ANY);
  const [bArm, setBArm] = useState(ANY);
  const [bBasis, setBBasis] = useState(ANY);
  const [bAmbiguous, setBAmbiguous] = useState(ANY);
  const [busy, setBusy] = useState<boolean | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState<boolean | null>(null);

  const filter: HarmonizeFlagFilter = {
    ...(bKind !== ANY && { kind: bKind as HarmonizeItemKind }),
    ...(bArm !== ANY && { arm: bArm as HarmonizeArm }),
    ...(bBasis !== ANY && { basis: bBasis }),
    ...(bAmbiguous !== ANY && { ambiguous: bAmbiguous === "yes" }),
  };

  const everything = Object.keys(filter).length === 0;
  const ask = (flagged: boolean) => (everything ? setConfirmAll(flagged) : void run(flagged));

  const run = async (flagged: boolean) => {
    setBusy(flagged);
    setError(null);
    setResult(null);
    try {
      const res = await bulkHarmonizeFlags(jobId, { filter, flagged });
      const msg = `${plural(res.updated, "item")} matched and ${res.updated === 1 ? "is" : "are"} now ${flagged ? "flagged" : "not flagged"}. ${plural(res.flaggedTotal, "item")} flagged in this run.`;
      setResult(msg);
      onChanged(msg);
      await invalidateFlagQueries(queryClient, jobId);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel
      id="bulk-flags"
      title="Flag or clear in bulk"
      description={`Every item matching all the choices below changes at once. Basis and ambiguous apply to links${kind === "harmonize_many" ? ", which many-cohort runs do not have" : ""}.`}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-4" role="group" aria-label="Bulk filter">
          <FilterSelect id="b-kind" label="Items of kind" value={bKind} onChange={setBKind} options={KIND_OPTIONS} />
          <FilterSelect id="b-arm" label="In arm" value={bArm} onChange={setBArm} options={ARM_OPTIONS} />
          <FilterSelect id="b-basis" label="Link basis" value={bBasis} onChange={setBBasis} options={BASES} />
          <FilterSelect
            id="b-amb"
            label="Ambiguous"
            value={bAmbiguous}
            onChange={setBAmbiguous}
            options={[
              [ANY, "Either"],
              ["yes", "Ambiguous only"],
              ["no", "Not ambiguous"],
            ]}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => ask(true)} disabled={busy !== null}>
            {busy === true && <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" />}
            Flag matching items
          </Button>
          <Button variant="secondary" onClick={() => ask(false)} disabled={busy !== null}>
            {busy === false && <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" />}
            Clear flags on matching items
          </Button>
        </div>
        {result && (
          <p role="status" className="text-sm text-neutral-700" data-testid="bulk-result">
            {result}
          </p>
        )}
        {error && (
          <Note tone="danger" title="The bulk change did not apply">
            {error}
          </Note>
        )}
      </div>
      <AlertDialog open={confirmAll !== null} onOpenChange={(open) => !open && setConfirmAll(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmAll ? "Flag every item in this run?" : "Clear every flag in this run?"}</AlertDialogTitle>
            <AlertDialogDescription>
              Every choice above is on its widest setting, so this changes every item of the run. Your own flags and
              clears cannot be brought back. Reset all flags returns only to biomapper's suggestion.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep flags as they are</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const flagged = confirmAll === true;
                setConfirmAll(null);
                void run(flagged);
              }}
            >
              {confirmAll ? "Flag every item" : "Clear every flag"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  );
}
