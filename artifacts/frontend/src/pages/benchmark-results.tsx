import { useEffect, useMemo, useState } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  getBenchmarkRun, getRowLogs, type CorpusMetric, type RowLog,
} from "@/lib/benchmark-api";
import { escapeCsvField } from "@/lib/benchmark-csv";
import { useBenchmarkStream } from "@/hooks/use-benchmark-stream";

const CATEGORIES = [
  "EXACT_MATCH", "NORMALIZED_MATCH", "NO_OVERLAP", "RETURNED_EMPTY",
  "GROUND_TRUTH_EMPTY", "MALFORMED_GROUND_TRUTH", "MALFORMED_RETURNED", "RUN_ERROR",
];

const LABEL_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  SHIP: "default", RERANK: "secondary", "ADD ANNOTATORS": "outline", "FIX UPSTREAM": "destructive",
};

function download(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function CorpusTable({ metrics }: { metrics: CorpusMetric[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Vocab</TableHead>
          <TableHead>Decision</TableHead>
          <TableHead className="text-right">n</TableHead>
          <TableHead className="text-right">Hit@1</TableHead>
          <TableHead className="text-right">MAP</TableHead>
          <TableHead className="text-right">Hit@∞</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {metrics.map((m) => {
          const rankCell = (v: number) =>
            m.orderAsserted ? v.toFixed(2) : <span className="text-neutral-400" title="ordering not confidence-verified">—/SDK</span>;
          return (
            <>
              <TableRow key={m.vocabulary}>
                <TableCell className="font-medium">{m.vocabulary}</TableCell>
                <TableCell>
                  <Badge variant={LABEL_VARIANT[m.decisionLabel] ?? "outline"}>{m.decisionLabel}</Badge>
                  {m.runErrorCount > 0 && (
                    <span className="ml-2 text-xs text-amber-600">{m.runErrorCount} run errors</span>
                  )}
                </TableCell>
                <TableCell className="text-right">{m.n}</TableCell>
                <TableCell className="text-right">{rankCell(m.hitAt1)}</TableCell>
                <TableCell className="text-right">{rankCell(m.map)}</TableCell>
                <TableCell className="text-right">{m.hitAtInf.toFixed(2)}</TableCell>
                <TableCell>
                  <Button variant="ghost" size="sm"
                    onClick={() => setExpanded(expanded === m.vocabulary ? null : m.vocabulary)}>
                    {expanded === m.vocabulary ? "Hide" : "Details"}
                  </Button>
                </TableCell>
              </TableRow>
              {expanded === m.vocabulary && (
                <TableRow>
                  <TableCell colSpan={7} className="bg-neutral-50 text-sm">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                      <div>MRR: {m.mrr.toFixed(2)}</div>
                      <div>Hit@5: {m.hitAt5.toFixed(2)}</div>
                      <div>Mean Recall@5: {m.meanRecallAt5.toFixed(2)}</div>
                      <div>Mean candidates: {m.meanCandidates.toFixed(2)}</div>
                      <div>Ranking gap: {m.diagnostics.rankingGap}</div>
                      <div>Rerank headroom: {m.diagnostics.rerankingHeadroom}</div>
                      <div>Recall headroom: {m.diagnostics.recallHeadroom}</div>
                      <div>Norm lift: {m.normalizationLift}</div>
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </>
          );
        })}
      </TableBody>
    </Table>
  );
}

export default function BenchmarkResultsPage() {
  const { runId } = useParams<{ runId: string }>();
  const [, navigate] = useLocation();

  const runQuery = useQuery({
    queryKey: ["benchmark-run", runId],
    queryFn: () => getBenchmarkRun(runId),
    refetchInterval: (q) =>
      q.state.data && ["pending", "processing"].includes(q.state.data.status) ? 2000 : false,
  });
  const run = runQuery.data;
  const inProgress = !!run && ["pending", "processing"].includes(run.status);
  const { progress } = useBenchmarkStream(runId, inProgress);

  useEffect(() => {
    if (progress?.status === "complete" || progress?.status === "error") {
      runQuery.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress?.status]);

  // Per-row log filters
  const [category, setCategory] = useState<string>("");
  const [vocab, setVocab] = useState<string>("");
  const [rerankable, setRerankable] = useState(false);
  const rowsQuery = useQuery({
    queryKey: ["benchmark-rows", runId, category, vocab, rerankable],
    queryFn: () =>
      getRowLogs(runId, {
        category: category || undefined,
        vocabulary: vocab || undefined,
        rerankable,
        limit: 1000,
      }),
    enabled: !!run && run.status === "complete",
  });
  const rows: RowLog[] = rowsQuery.data ?? [];

  const vocabOptions = useMemo(
    () => (run?.corpus_metrics ?? []).map((m) => m.vocabulary),
    [run],
  );

  function exportCsv() {
    const header = ["name", "vocabulary", "ground_truth", "returned_ids", "hit_ranks", "category"];
    const lines = [header.join(",")];
    for (const r of rows) {
      lines.push(header.map((k) => escapeCsvField(String((r as any)[k] ?? ""))).join(","));
    }
    download(`benchmark-${runId}.csv`, lines.join("\n"), "text/csv");
  }
  function exportJsonl() {
    download(`benchmark-${runId}.jsonl`, rows.map((r) => JSON.stringify(r)).join("\n"), "application/x-ndjson");
  }

  if (runQuery.isLoading) {
    return <div className="max-w-4xl mx-auto py-8 px-4 space-y-3"><Skeleton className="h-8 w-64" /><Skeleton className="h-40 w-full" /></div>;
  }
  if (runQuery.isError || !run) {
    return (
      <div className="max-w-4xl mx-auto py-8 px-4">
        <Alert variant="destructive"><AlertDescription>Could not load this run.</AlertDescription></Alert>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto py-8 px-4 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{run.dataset_name ?? "Benchmark run"}</h1>
          <p className="text-sm text-neutral-500">
            {run.total} names · SDK {run.sdk_version ?? "unknown"} · env {run.env}
          </p>
        </div>
        <Button variant="outline" onClick={() => navigate("/benchmark/runs")}>Run history</Button>
      </div>

      {!run.order_asserted && (
        <Alert>
          <AlertDescription>
            Candidate ordering is not confidence-verified for this SDK version — rank metrics
            (Hit@1/MAP/MRR) are shown as “—/SDK” and only coverage (Hit@∞, recall) is reliable.
          </AlertDescription>
        </Alert>
      )}

      {inProgress && (
        <Card>
          <CardHeader><CardTitle>Running…</CardTitle></CardHeader>
          <CardContent>
            <p className="text-sm text-neutral-500">
              {progress?.completed ?? 0}/{progress?.total ?? run.total} mapped, then scoring.
            </p>
          </CardContent>
        </Card>
      )}

      {(run.status === "error" || run.status === "interrupted") && (
        <Alert variant="destructive">
          <AlertDescription>
            This run ended with status “{run.status}”. {run.error_message}
          </AlertDescription>
        </Alert>
      )}

      {run.status === "complete" && run.corpus_metrics && (
        <>
          <Card>
            <CardHeader><CardTitle>Corpus metrics</CardTitle></CardHeader>
            <CardContent>
              {run.corpus_metrics.length ? (
                <CorpusTable metrics={run.corpus_metrics} />
              ) : (
                <p className="text-sm text-neutral-500">No scorable rows.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Per-row disagreement log</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Select value={category || "__all__"} onValueChange={(v) => setCategory(v === "__all__" ? "" : v)}>
                  <SelectTrigger className="w-52"><SelectValue placeholder="Category" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">All categories</SelectItem>
                    {CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={vocab || "__all__"} onValueChange={(v) => setVocab(v === "__all__" ? "" : v)}>
                  <SelectTrigger className="w-40"><SelectValue placeholder="Vocab" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">All vocabs</SelectItem>
                    {vocabOptions.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Button variant={rerankable ? "default" : "outline"} size="sm" onClick={() => setRerankable((r) => !r)}>
                  Rerankable rows
                </Button>
                <div className="ml-auto flex gap-2">
                  <Button variant="outline" size="sm" onClick={exportCsv}>Export CSV</Button>
                  <Button variant="outline" size="sm" onClick={exportJsonl}>Export JSONL</Button>
                </div>
              </div>

              {rowsQuery.isLoading ? (
                <Skeleton className="h-40 w-full" />
              ) : rows.length === 0 ? (
                <p className="text-sm text-neutral-500">
                  {rerankable
                    ? "No rerankable rows — matches are already at rank 1 or near ceiling."
                    : "No rows match the current filters."}
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Vocab</TableHead>
                      <TableHead>Ground truth</TableHead>
                      <TableHead>Returned</TableHead>
                      <TableHead>Hit ranks</TableHead>
                      <TableHead>Category</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.slice(0, 500).map((r, i) => (
                      <TableRow key={`${r.name}-${r.vocabulary}-${i}`}
                        className={r.category.startsWith("MALFORMED") ? "bg-amber-50" : undefined}>
                        <TableCell className="font-medium">{r.name}</TableCell>
                        <TableCell>{r.vocabulary}</TableCell>
                        <TableCell className="max-w-[12rem] truncate" title={r.ground_truth}>{r.ground_truth}</TableCell>
                        <TableCell className="max-w-[12rem] truncate" title={r.returned_ids}>{r.returned_ids}</TableCell>
                        <TableCell>{r.hit_ranks || "—"}</TableCell>
                        <TableCell><Badge variant="outline">{r.category}</Badge></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {rows.length > 500 && (
                <p className="text-xs text-neutral-400">Showing first 500 of {rows.length} rows.</p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
