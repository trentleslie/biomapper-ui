import { Fragment, useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  useListHarmonizeItems,
  getListHarmonizeItemsQueryKey,
  useSetHarmonizeFlags,
  useBulkHarmonizeFlags,
  useResetHarmonizeFlags,
  type HarmonizeItem,
  type ListHarmonizeItemsParams,
  type HarmonizeFlagFilter,
} from "@workspace/api-client-react";
import { ChevronDown, ChevronRight, Flag, Loader2, RotateCcw, ListChecks } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { FieldTooltip } from "@/components/field-tooltip";
import { EmptyState, LoadError, Notice, SkeletonLines } from "@/components/harmonize/common";
import { ITEM_KIND_LABEL, armLabel, describeItem, errorMessage } from "@/lib/harmonize";

export const EITL_PREVIEW_KEY = (jobId: string) => ["harmonize-eitl-preview", jobId] as const;

/** Every query that shows flags for this run: the item pages and the EITL file preview. */
export function invalidateFlags(queryClient: QueryClient, jobId: string) {
  void queryClient.invalidateQueries({ queryKey: getListHarmonizeItemsQueryKey(jobId) });
  void queryClient.invalidateQueries({ queryKey: EITL_PREVIEW_KEY(jobId) });
}

const ANY = "any";
const PAGE_SIZES = [100, 250, 1000];

type Filters = { kind: string; arm: string; flagged: string };

export function ItemsPanel({ jobId, kind }: { jobId: string; kind: string }) {
  const queryClient = useQueryClient();
  const many = kind === "harmonize_many";
  const [filters, setFilters] = useState<Filters>({ kind: ANY, arm: ANY, flagged: ANY });
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(100);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  const params: ListHarmonizeItemsParams = {
    ...(filters.kind !== ANY ? { kind: filters.kind as ListHarmonizeItemsParams["kind"] } : {}),
    ...(filters.arm !== ANY ? { arm: filters.arm as ListHarmonizeItemsParams["arm"] } : {}),
    ...(filters.flagged !== ANY ? { flagged: filters.flagged === "yes" } : {}),
    offset,
    limit,
  };
  const items = useListHarmonizeItems(jobId, params, {
    query: { queryKey: getListHarmonizeItemsQueryKey(jobId, params), placeholderData: keepPreviousData, retry: 1 },
  });

  // A new filter or page size starts at the first page with nothing selected.
  useEffect(() => {
    setOffset(0);
    setSelected(new Set());
  }, [filters, limit]);

  const done = (text: string) => {
    setMessage({ tone: "success", text });
    setSelected(new Set());
    invalidateFlags(queryClient, jobId);
  };
  const failed = (e: unknown) => setMessage({ tone: "danger", text: errorMessage(e) });

  const setFlags = useSetHarmonizeFlags({
    mutation: {
      onSuccess: (r, v) =>
        done(`${v.data.flagged ? "Flagged" : "De-flagged"} ${r.updated} item${r.updated === 1 ? "" : "s"}. ${r.flaggedTotal} flagged in this run.`),
      onError: failed,
    },
  });
  const reset = useResetHarmonizeFlags({
    mutation: {
      onSuccess: (r, v) =>
        done(`${v.data?.refs ? `Reset ${v.data.refs.length} item${v.data.refs.length === 1 ? "" : "s"}` : "Reset every item"} to biomapper's suggestion. ${r.flaggedTotal} flagged in this run.`),
      onError: failed,
    },
  });

  const page = items.data;
  const rows = page?.items ?? [];
  const total = page?.total ?? 0;
  const busy = setFlags.isPending || reset.isPending;
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.ref));

  const toggleSel = (ref: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });

  return (
    <Card data-testid="items-panel">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center">
              Review and flag
              <FieldTooltip label="How flags work">
                Flag the {many ? "groups" : "links"} an expert should check. biomapper starts every review entry, every
                ambiguous link and every group with multiplicity flagged; you can flag or de-flag anything. Flags are
                saved on the server as you go. Accepting or rejecting happens later, in the expert-review app.
              </FieldTooltip>
            </CardTitle>
            <CardDescription>
              biomapper's suggestion is already applied: review entries, ambiguous links and groups with multiplicity
              start flagged. Your changes are kept for this run.
            </CardDescription>
          </div>
          <div className="flex gap-3 text-sm" data-testid="items-totals">
            <div className="rounded border border-neutral-200 px-3 py-1.5">
              <p className="text-xs text-neutral-500">Items shown by the filters</p>
              <p className="font-semibold tabular-nums" data-testid="items-total">{page ? total.toLocaleString() : "..."}</p>
            </div>
            <div className="rounded border border-warning-border bg-warning-bg px-3 py-1.5">
              <p className="text-xs text-neutral-600">Flagged in this run</p>
              <p className="font-semibold tabular-nums text-warning" data-testid="items-flagged-total">
                {page ? page.flaggedTotal.toLocaleString() : "..."}
              </p>
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-3" data-testid="items-filters">
          <FilterSelect id="items-kind" ariaLabel="Show kind" label="Kind" value={filters.kind} onChange={(v) => setFilters((f) => ({ ...f, kind: v }))}
            options={[
              [ANY, "All kinds"],
              many ? ["group", "Groups"] : ["link", "Links"],
              ["review", "Review entries"],
              ["unresolved", "Unresolved rows"],
              many ? ["link", "Links (none on many-cohort runs)"] : ["group", "Groups (none on two-cohort runs)"],
            ]} />
          <FilterSelect id="items-arm" ariaLabel="Show arm" label="Arm" value={filters.arm} onChange={(v) => setFilters((f) => ({ ...f, arm: v }))}
            options={[[ANY, "Both arms"], ["names_only", "Names only"], ["identifier", "Identifier"]]} />
          <FilterSelect id="items-flagged" ariaLabel="Show flag state" label="Flag" value={filters.flagged} onChange={(v) => setFilters((f) => ({ ...f, flagged: v }))}
            options={[[ANY, "Flagged and not flagged"], ["yes", "Flagged only"], ["no", "Not flagged only"]]} />
          <FilterSelect id="items-page-size" ariaLabel="Items per page" label="Per page" value={String(limit)} onChange={(v) => setLimit(Number(v))}
            options={PAGE_SIZES.map((n) => [String(n), String(n)] as [string, string])} />
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <BulkFlags jobId={jobId} many={many} onDone={done} onError={failed} />

        <div className="flex flex-wrap items-center gap-2 border-t border-neutral-100 pt-4" data-testid="selection-actions">
          <span className="text-sm text-neutral-600">{selected.size} selected</span>
          <Button size="sm" variant="outline" disabled={selected.size === 0 || busy}
            onClick={() => setFlags.mutate({ jobId, data: { refs: [...selected], flagged: true } })}>
            <Flag /> Flag selected
          </Button>
          <Button size="sm" variant="outline" disabled={selected.size === 0 || busy}
            onClick={() => setFlags.mutate({ jobId, data: { refs: [...selected], flagged: false } })}>
            De-flag selected
          </Button>
          <Button size="sm" variant="outline" disabled={selected.size === 0 || busy}
            onClick={() => reset.mutate({ jobId, data: { refs: [...selected] } })} data-testid="btn-reset-selected">
            <RotateCcw /> Reset selected to biomapper's suggestion
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="ghost" disabled={busy} data-testid="btn-reset-all">
                <RotateCcw /> Reset all flags
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Reset all flags to biomapper's suggestion?</AlertDialogTitle>
                <AlertDialogDescription>
                  Every flag you changed on this run goes back to what biomapper suggested.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep my flags</AlertDialogCancel>
                <AlertDialogAction onClick={() => reset.mutate({ jobId, data: {} })}>Reset all flags</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          {busy && <Loader2 aria-label="Saving flags" className="h-4 w-4 animate-spin text-neutral-500" />}
        </div>

        {message && <Notice tone={message.tone} testId="flag-message">{message.text}</Notice>}

        {items.isLoading ? (
          <SkeletonLines lines={6} label="Loading items" />
        ) : items.isError ? (
          <LoadError what="the items" message={errorMessage(items.error)} onRetry={() => void items.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState icon={ListChecks} title="No items match these filters" description="Change the kind, arm or flag filter to see other items." />
        ) : (
          <div className="max-h-[36rem] rounded border border-neutral-200 scroll-visible" data-testid="items-scroll">
            <Table>
              <TableHeader className="sticky top-0 z-10">
                <TableRow>
                  <TableHead className="w-8">
                    <Checkbox
                      aria-label="Select every item on this page"
                      checked={allOnPage}
                      onCheckedChange={(v) => setSelected(v === true ? new Set(rows.map((r) => r.ref)) : new Set())}
                    />
                  </TableHead>
                  <TableHead className="w-8"><span className="sr-only">Details</span></TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Arm</TableHead>
                  <TableHead>Members</TableHead>
                  <TableHead>What it is</TableHead>
                  <TableHead>Flag</TableHead>
                  <TableHead>Flag set by</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((item) => (
                  <ItemRow
                    key={item.ref}
                    item={item}
                    selected={selected.has(item.ref)}
                    expanded={expanded === item.ref}
                    busy={busy}
                    onSelect={() => toggleSel(item.ref)}
                    onExpand={() => setExpanded((e) => (e === item.ref ? null : item.ref))}
                    onFlag={(flagged) => setFlags.mutate({ jobId, data: { refs: [item.ref], flagged } })}
                    onReset={() => reset.mutate({ jobId, data: { refs: [item.ref] } })}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {page && total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2" data-testid="items-paging">
            <p className="text-sm text-neutral-500">
              Showing {(offset + 1).toLocaleString()} to {Math.min(offset + limit, total).toLocaleString()} of {total.toLocaleString()} items
              {items.isFetching && !items.isLoading ? " (updating)" : ""}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => { setOffset(Math.max(0, offset - limit)); setSelected(new Set()); }}>
                Previous page
              </Button>
              <Button variant="outline" size="sm" disabled={offset + limit >= total} onClick={() => { setOffset(offset + limit); setSelected(new Set()); }}>
                Next page
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FilterSelect({ id, label, ariaLabel, value, onChange, options }: {
  id: string;
  label: string;
  ariaLabel?: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<[string, string]>;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs text-neutral-500">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} aria-label={ariaLabel ?? label} className="h-8 w-auto min-w-[9rem] text-sm" data-testid={`select-${id}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([v, l]) => (
            <SelectItem key={v} value={v}>{l}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function ItemRow({ item, selected, expanded, busy, onSelect, onExpand, onFlag, onReset }: {
  item: HarmonizeItem;
  selected: boolean;
  expanded: boolean;
  busy: boolean;
  onSelect: () => void;
  onExpand: () => void;
  onFlag: (flagged: boolean) => void;
  onReset: () => void;
}) {
  const detail = (item.detail ?? {}) as Record<string, unknown>;
  const what = describeItem(item.kind, detail);
  // Names can repeat across rows and arms, so the accessible name carries the keys and the arm too.
  const shown = item.members.slice(0, 2).map((m) => `${m.name || m.key} (${m.key})`).join(" with ");
  const more = item.members.length > 2 ? ` and ${item.members.length - 2} more` : "";
  const who = `${shown || item.ref}${more}, ${armLabel(item.arm).toLowerCase()} arm`;
  return (
    <Fragment>
      <TableRow className={item.flagged ? "bg-warning-bg/40" : undefined} data-testid="item-row" data-ref={item.ref}>
        <TableCell>
          <Checkbox checked={selected} onCheckedChange={onSelect} aria-label={`Select ${ITEM_KIND_LABEL[item.kind] ?? item.kind} ${who}`} />
        </TableCell>
        <TableCell>
          <button type="button" onClick={onExpand} aria-expanded={expanded} aria-label={`Details of ${ITEM_KIND_LABEL[item.kind] ?? item.kind} ${who}`}
            className="rounded p-0.5 text-neutral-500 hover:bg-neutral-100">
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        </TableCell>
        <TableCell><Badge variant="outline">{ITEM_KIND_LABEL[item.kind] ?? item.kind}</Badge></TableCell>
        <TableCell className="whitespace-nowrap text-xs">{armLabel(item.arm)}</TableCell>
        <TableCell className="min-w-[16rem]">
          <ul className="space-y-0.5 text-xs">
            {item.members.length === 0 && <li className="text-neutral-500">No member rows</li>}
            {item.members.map((m, i) => (
              <li key={`${m.cohort}:${m.key}:${i}`} className="flex flex-wrap gap-x-1.5">
                <span className="font-mono text-neutral-500">{m.cohort}</span>
                <span className="font-mono">{m.key}</span>
                <span className="text-neutral-900">{m.name ?? <span className="text-neutral-400">no name</span>}</span>
                {m.chosenKgId && <span className="font-mono text-neutral-500">{m.chosenKgId}</span>}
              </li>
            ))}
          </ul>
        </TableCell>
        <TableCell className="min-w-[12rem] text-xs">
          <ul className="space-y-0.5">
            {what.map((w, i) => (
              <li key={i} className={i === 0 ? "font-medium text-neutral-900" : "text-neutral-600"}>{w}</li>
            ))}
          </ul>
        </TableCell>
        <TableCell>
          <Button
            size="sm"
            variant={item.flagged ? "default" : "outline"}
            className="h-7 px-2 text-xs"
            aria-pressed={item.flagged}
            disabled={busy}
            onClick={() => onFlag(!item.flagged)}
            aria-label={`${item.flagged ? "De-flag" : "Flag"} ${ITEM_KIND_LABEL[item.kind] ?? item.kind} ${who}`}
            data-testid="btn-item-flag"
          >
            <Flag className="h-3 w-3" /> {item.flagged ? "Flagged" : "Flag"}
          </Button>
        </TableCell>
        <TableCell className="whitespace-nowrap text-xs" data-testid="item-source">
          <span className={item.source === "organizer" ? "font-medium text-ph-navy" : "text-neutral-600"}>
            {item.source === "organizer" ? "organizer (you)" : "biomapper"}
          </span>
          <span className="block text-neutral-500">suggested: {item.suggested ? "flag" : "no flag"}</span>
          {item.source === "organizer" && (
            <button type="button" className="mt-0.5 text-ph-navy underline-offset-2 hover:underline" onClick={onReset} disabled={busy}
              aria-label={`Reset ${who} to biomapper's suggestion`}>
              Reset
            </button>
          )}
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="bg-neutral-50">
          <TableCell colSpan={8} className="px-6 py-3">
            <DetailList detail={detail} itemRef={item.ref} />
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
}

function DetailList({ detail, itemRef }: { detail: Record<string, unknown>; itemRef: string }) {
  const entries = useMemo(() => Object.entries(detail).filter(([, v]) => v !== null && v !== undefined && v !== ""), [detail]);
  return (
    <div className="text-xs">
      <p className="mb-2 text-neutral-500">Reference <span className="font-mono">{itemRef}</span></p>
      <dl className="grid grid-cols-[minmax(10rem,auto)_1fr] gap-x-4 gap-y-1">
        {entries.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="font-mono text-neutral-500">{k}</dt>
            <dd className="min-w-0 break-words font-mono text-neutral-900">{formatValue(v)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function formatValue(v: unknown): string {
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v)) return v.length === 0 ? "none" : v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ");
  if (typeof v === "object" && v !== null) return JSON.stringify(v);
  return String(v);
}

function BulkFlags({ jobId, many, onDone, onError }: {
  jobId: string;
  many: boolean;
  onDone: (text: string) => void;
  onError: (e: unknown) => void;
}) {
  const [kind, setKind] = useState(ANY);
  const [arm, setArm] = useState(ANY);
  const [basis, setBasis] = useState(ANY);
  const [ambiguous, setAmbiguous] = useState(ANY);
  const bulk = useBulkHarmonizeFlags({
    mutation: {
      onSuccess: (r, v) =>
        onDone(`${r.updated} item${r.updated === 1 ? "" : "s"} matched and ${r.updated === 1 ? "was" : "were"} ${v.data.flagged ? "flagged" : "de-flagged"}. ${r.flaggedTotal} flagged in this run.`),
      onError,
    },
  });
  const filter: HarmonizeFlagFilter = {
    ...(kind !== ANY ? { kind: kind as HarmonizeFlagFilter["kind"] } : {}),
    ...(arm !== ANY ? { arm: arm as HarmonizeFlagFilter["arm"] } : {}),
    ...(basis !== ANY ? { basis } : {}),
    ...(ambiguous !== ANY ? { ambiguous: ambiguous === "yes" } : {}),
  };
  return (
    <div className="rounded border border-neutral-200 bg-neutral-50 p-3" data-testid="bulk-flags">
      <p className="mb-2 text-sm font-medium text-neutral-900">
        Flag in bulk
        <FieldTooltip label="Help: Flag in bulk">
          Flags or de-flags every item of the run that matches all the chosen fields, on every page. Basis and
          ambiguous apply to links only.
        </FieldTooltip>
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <FilterSelect id="bulk-kind" ariaLabel="Bulk kind" label="Kind" value={kind} onChange={setKind}
          options={[[ANY, "Any kind"], ["link", "Links"], ["group", "Groups"], ["review", "Review entries"], ["unresolved", "Unresolved rows"]]} />
        <FilterSelect id="bulk-arm" ariaLabel="Bulk arm" label="Arm" value={arm} onChange={setArm}
          options={[[ANY, "Both arms"], ["names_only", "Names only"], ["identifier", "Identifier"]]} />
        <FilterSelect id="bulk-basis" ariaLabel="Bulk basis" label="Basis" value={basis} onChange={setBasis}
          options={[[ANY, "Any basis"], ["node", "node"], ["identifier", "identifier"], ["name_exact", "name_exact"], ["name_casefold", "name_casefold"]]} />
        <FilterSelect id="bulk-ambiguous" ariaLabel="Bulk ambiguous" label="Ambiguous" value={ambiguous} onChange={setAmbiguous}
          options={[[ANY, "Either"], ["yes", "Ambiguous"], ["no", "One-to-one"]]} />
        <div className="flex gap-2">
          <Button size="sm" disabled={bulk.isPending} onClick={() => bulk.mutate({ jobId, data: { filter, flagged: true } })} data-testid="btn-bulk-flag">
            <Flag /> Flag matching
          </Button>
          <Button size="sm" variant="outline" disabled={bulk.isPending} onClick={() => bulk.mutate({ jobId, data: { filter, flagged: false } })} data-testid="btn-bulk-deflag">
            De-flag matching
          </Button>
        </div>
      </div>
      {many && (basis !== ANY || ambiguous !== ANY) && (
        <p className="mt-2 text-xs text-neutral-500">Many-cohort runs have no links, so a basis or ambiguous filter matches nothing here.</p>
      )}
    </div>
  );
}
