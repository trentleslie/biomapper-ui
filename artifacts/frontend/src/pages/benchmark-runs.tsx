import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  compareRuns, deleteBenchmarkRun, listBenchmarkRuns,
  type BenchmarkRun, type CompareResult,
} from "@/lib/benchmark-api";

function headline(run: BenchmarkRun): string {
  const hmdb = run.corpus_metrics?.find((m) => m.vocabulary === "hmdb");
  if (!hmdb) return "—";
  return `Hit@1 ${hmdb.orderAsserted ? hmdb.hitAt1.toFixed(2) : "—"} · MAP ${hmdb.orderAsserted ? hmdb.map.toFixed(2) : "—"}`;
}

function MismatchBanner({ mismatch }: { mismatch: Record<string, boolean> }) {
  const flagged = Object.entries(mismatch).filter(([, v]) => v).map(([k]) => k);
  if (!flagged.length) return null;
  return (
    <Alert variant="destructive">
      <AlertDescription>
        These runs differ in: {flagged.join(", ")}. Metric deltas may reflect that difference,
        not a genuine improvement.
      </AlertDescription>
    </Alert>
  );
}

function CompareView({ result }: { result: CompareResult }) {
  const vocabs = Array.from(new Set([
    ...(result.a.corpus_metrics ?? []).map((m) => m.vocabulary),
    ...(result.b.corpus_metrics ?? []).map((m) => m.vocabulary),
  ]));
  const get = (run: BenchmarkRun, v: string) => run.corpus_metrics?.find((m) => m.vocabulary === v);
  return (
    <Card>
      <CardHeader><CardTitle>Comparison</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <MismatchBanner mismatch={result.mismatch} />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Vocab · metric</TableHead>
              <TableHead className="text-right">{result.a.dataset_name ?? "A"}</TableHead>
              <TableHead className="text-right">{result.b.dataset_name ?? "B"}</TableHead>
              <TableHead className="text-right">Δ</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {vocabs.flatMap((v) => {
              const a = get(result.a, v);
              const b = get(result.b, v);
              return (["hitAt1", "map", "hitAtInf"] as const).map((metric) => {
                const av = a?.[metric] ?? 0;
                const bv = b?.[metric] ?? 0;
                return (
                  <TableRow key={`${v}-${metric}`}>
                    <TableCell>{v} · {metric}</TableCell>
                    <TableCell className="text-right">{av.toFixed(2)}</TableCell>
                    <TableCell className="text-right">{bv.toFixed(2)}</TableCell>
                    <TableCell className="text-right">{(bv - av >= 0 ? "+" : "") + (bv - av).toFixed(2)}</TableCell>
                  </TableRow>
                );
              });
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export default function BenchmarkRunsPage() {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const runsQuery = useQuery({ queryKey: ["benchmark-runs"], queryFn: listBenchmarkRuns });
  const [selected, setSelected] = useState<string[]>([]);
  const [comparison, setComparison] = useState<CompareResult | null>(null);

  const del = useMutation({
    mutationFn: (runId: string) => deleteBenchmarkRun(runId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["benchmark-runs"] }),
  });

  function toggle(runId: string) {
    setSelected((sel) =>
      sel.includes(runId) ? sel.filter((r) => r !== runId) : sel.length < 2 ? [...sel, runId] : sel,
    );
  }

  async function doCompare() {
    if (selected.length !== 2) return;
    setComparison(await compareRuns(selected[0], selected[1]));
  }

  const runs = runsQuery.data ?? [];

  return (
    <div className="max-w-5xl mx-auto py-8 px-4 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Benchmark runs</h1>
        <div className="flex gap-2">
          <Button variant="secondary" disabled={selected.length !== 2} onClick={doCompare}>
            Compare {selected.length === 2 ? "" : "(select 2)"}
          </Button>
          <Button onClick={() => navigate("/benchmark")}>New benchmark</Button>
        </div>
      </div>

      {comparison && <CompareView result={comparison} />}

      <Card>
        <CardContent className="pt-6">
          {runsQuery.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : runsQuery.isError ? (
            <Alert variant="destructive"><AlertDescription>Could not load runs.</AlertDescription></Alert>
          ) : runs.length === 0 ? (
            <p className="text-sm text-neutral-500">No benchmark runs yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>Dataset</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Headline (HMDB)</TableHead>
                  <TableHead>SDK</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => (
                  <TableRow key={run.run_id}>
                    <TableCell>
                      <input
                        type="checkbox"
                        checked={selected.includes(run.run_id)}
                        disabled={!selected.includes(run.run_id) && selected.length >= 2}
                        onChange={() => toggle(run.run_id)}
                      />
                    </TableCell>
                    <TableCell className="font-medium cursor-pointer"
                      onClick={() => navigate(`/benchmark/runs/${run.run_id}`)}>
                      {run.dataset_name ?? run.run_id.slice(0, 8)}
                    </TableCell>
                    <TableCell><Badge variant="outline">{run.status}</Badge></TableCell>
                    <TableCell>{run.status === "complete" ? headline(run) : "—"}</TableCell>
                    <TableCell className="text-sm text-neutral-500">{run.sdk_version ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="sm">Delete</Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete run?</AlertDialogTitle>
                            <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => del.mutate(run.run_id)}>Delete</AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
