import { Fragment, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import {
  useListHarmonizeReviewItems,
  getListHarmonizeReviewItemsQueryKey,
  useGetHarmonizeReviewItem,
  getGetHarmonizeReviewItemQueryKey,
  type HarmonizeSideDetail,
  type ListHarmonizeReviewItemsParams,
} from "@workspace/api-client-react";
import { ChevronDown, ChevronRight, SearchCheck } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, FactList, LoadError, SkeletonLines } from "@/components/harmonize/common";
import { errorMessage } from "@/lib/harmonize";

const PAGE = 25;

/**
 * biomapper's own review items (rows and links), highest impact first. Opening one shows the evidence the package
 * captured: for a row the engine's choice, certificate state and candidates status; for a link both sides.
 */
export function ReviewItemsPanel({ jobId }: { jobId: string }) {
  const [kind, setKind] = useState<"all" | "row" | "link">("all");
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const params: ListHarmonizeReviewItemsParams = { ...(kind !== "all" ? { kind } : {}), offset, limit: PAGE };
  const page = useListHarmonizeReviewItems(jobId, params, {
    query: { queryKey: getListHarmonizeReviewItemsQueryKey(jobId, params), placeholderData: keepPreviousData, retry: 1 },
  });
  const data = page.data;
  const items = data?.items ?? [];

  return (
    <Card data-testid="review-items-panel">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Review evidence</CardTitle>
            <CardDescription>
              biomapper's review items, highest impact first. Open one to see what the engine chose and why it needs a
              second look.
            </CardDescription>
          </div>
          <Tabs value={kind} onValueChange={(v) => { setKind(v as typeof kind); setOffset(0); setOpen(null); }}>
            <TabsList aria-label="Review item kind">
              <TabsTrigger value="all">All{data?.counts ? ` (${(data.counts.row ?? 0) + (data.counts.link ?? 0)})` : ""}</TabsTrigger>
              <TabsTrigger value="row">Rows{data?.counts ? ` (${data.counts.row ?? 0})` : ""}</TabsTrigger>
              <TabsTrigger value="link">Links{data?.counts ? ` (${data.counts.link ?? 0})` : ""}</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {page.isLoading ? (
          <SkeletonLines lines={4} label="Loading review items" />
        ) : page.isError ? (
          <LoadError what="the review items" message={errorMessage(page.error)} onRetry={() => void page.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={SearchCheck}
            title="No review items"
            description={data?.note || "biomapper found nothing in this run that needs a second look."}
          />
        ) : (
          <>
            {data?.note && <p className="text-xs text-neutral-500">{data.note}</p>}
            <div className="max-h-[32rem] rounded border border-neutral-200 scroll-visible">
              <Table>
                <TableHeader className="sticky top-0 z-10">
                  <TableRow>
                    <TableHead className="w-8"><span className="sr-only">Open</span></TableHead>
                    <TableHead>Item</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Why</TableHead>
                    <TableHead>Nodes</TableHead>
                    <TableHead>Cohorts</TableHead>
                    <TableHead className="text-right">Impact</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((it) => {
                    const isOpen = open === it.ref;
                    return (
                      <Fragment key={it.ref}>
                        <TableRow className="cursor-pointer hover:bg-neutral-50" onClick={() => setOpen(isOpen ? null : it.ref)} data-testid="review-item-row">
                          <TableCell>
                            <button type="button" aria-expanded={isOpen} aria-label={`Open review item ${it.label}`}
                              onClick={(e) => { e.stopPropagation(); setOpen(isOpen ? null : it.ref); }}
                              className="rounded p-0.5 text-neutral-500 hover:bg-neutral-100">
                              {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            </button>
                          </TableCell>
                          <TableCell className="font-medium">{it.label || "(no name)"}</TableCell>
                          <TableCell><Badge variant="outline">{it.kind}</Badge></TableCell>
                          <TableCell className="text-xs">{it.reasons.join(", ") || "not stated"}</TableCell>
                          <TableCell className="font-mono text-xs">{it.nodes.length ? [...new Set(it.nodes)].join(", ") : "none"}</TableCell>
                          <TableCell className="font-mono text-xs">{it.cohorts.join(", ")}</TableCell>
                          <TableCell className="text-right tabular-nums">{it.impact}</TableCell>
                        </TableRow>
                        {isOpen && (
                          <TableRow className="bg-neutral-50">
                            <TableCell colSpan={7} className="px-6 py-4">
                              <ReviewDetail jobId={jobId} itemRef={it.ref} />
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-neutral-500">
                Showing {offset + 1} to {offset + items.length} of {data?.total ?? items.length}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => { setOffset(Math.max(0, offset - PAGE)); setOpen(null); }}>
                  Previous page
                </Button>
                <Button variant="outline" size="sm" disabled={data?.nextOffset == null} onClick={() => { setOffset(data?.nextOffset ?? offset); setOpen(null); }}>
                  Next page
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ReviewDetail({ jobId, itemRef }: { jobId: string; itemRef: string }) {
  const q = useGetHarmonizeReviewItem(jobId, itemRef, {
    query: { queryKey: getGetHarmonizeReviewItemQueryKey(jobId, itemRef), staleTime: Infinity, retry: 1 },
  });
  if (q.isLoading) return <SkeletonLines lines={3} label="Loading the review item" />;
  if (q.isError || !q.data) return <LoadError what="this review item" message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  const d = q.data;
  return (
    <div className="space-y-4 text-sm" data-testid="review-detail">
      {d.row && (
        <FactList
          rows={[
            { label: "Name", value: d.row.name ?? "not given" },
            { label: "Engine's choice", value: <span className="font-mono">{d.row.engineChoice ?? "none"}</span> },
            { label: "Certificate state", value: d.row.certificateState ?? "none recorded" },
            {
              label: "Candidates",
              value: `${d.row.candidatesStatus ?? "not recorded"}${d.row.candidatesReason ? `: ${d.row.candidatesReason}` : ""}`,
            },
            ...(d.row.weakTrigger ? [{ label: "Why it is weak", value: d.row.weakTrigger }] : []),
            ...(d.row.category ? [{ label: "Category", value: <span className="font-mono">{d.row.category}</span> }] : []),
            {
              label: "Rows",
              value: (d.row.rows ?? []).map((r) => `${r.cohort} ${r.key} ${r.name}`).join("; ") || "none",
            },
          ]}
        />
      )}
      {d.link && (
        <div className="space-y-3">
          {d.link.question && (
            <p className="rounded border border-info-border bg-info-bg px-3 py-2 text-info">
              <span className="font-semibold">Question to ask: </span>
              {d.link.question}
            </p>
          )}
          <FactList
            rows={[
              { label: "Link", value: `${d.link.linkKind ?? "link"}${d.link.basis ? `, basis ${d.link.basis}` : ""}` },
              ...(d.link.reviewReasons?.length ? [{ label: "Review reasons", value: d.link.reviewReasons.join(", ") }] : []),
              ...(d.link.nRowPairs != null ? [{ label: "Row pairs", value: String(d.link.nRowPairs) }] : []),
            ]}
          />
          <div className="grid gap-4 md:grid-cols-2">
            {d.link.a && <Side title="Side A" side={d.link.a} />}
            {d.link.b && <Side title="Side B" side={d.link.b} />}
          </div>
        </div>
      )}
      {d.suggestion && <p><span className="text-neutral-500">Suggestion: </span>{d.suggestion}</p>}
      {d.nextStep && <p><span className="text-neutral-500">Next step: </span>{d.nextStep}</p>}
      {d.note && <p className="text-xs text-neutral-500">{d.note}</p>}
    </div>
  );
}

function Side({ title, side }: { title: string; side: HarmonizeSideDetail }) {
  const ids = Object.entries(side.identifiers ?? {});
  const certs = Object.entries(side.certificateStates ?? {});
  return (
    <div className="rounded border border-neutral-200 bg-white p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">{title}</p>
      <FactList
        rows={[
          { label: "Node", value: <span className="font-mono">{side.node ?? "no node"}</span> },
          { label: "Node name", value: side.nodeName ?? side.nodeNameStatus ?? "not available" },
          { label: "Rows", value: (side.rows ?? []).map((r) => `${r.cohort} ${r.key} ${r.name}`).join("; ") || "none" },
          { label: "Certificate states", value: certs.length ? certs.map(([k, n]) => `${k} (${n})`).join(", ") : "none recorded" },
          {
            label: "Identifiers",
            value: ids.length ? (
              <div className="max-h-28 space-y-0.5 scroll-visible [scrollbar-gutter:auto]!">
                {ids.map(([v, list]) => (
                  <p key={v} className="font-mono text-xs"><span className="text-neutral-500">{v}:</span> {list.join(", ")}</p>
                ))}
              </div>
            ) : "none",
          },
        ]}
      />
    </div>
  );
}
