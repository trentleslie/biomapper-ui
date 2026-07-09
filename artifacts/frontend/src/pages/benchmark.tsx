import { useState } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  autoDetectMapping,
  buildPayload,
  parseCsv,
  VOCABULARIES,
  type ColumnMapping,
  type ParsedCsv,
} from "@/lib/benchmark-csv";
import { startBenchmark } from "@/lib/benchmark-api";

const IGNORE = "__ignore__";

export default function BenchmarkPage() {
  const [, navigate] = useLocation();
  const [csv, setCsv] = useState<ParsedCsv | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [datasetName, setDatasetName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState(false);

  function loadText(text: string, name: string) {
    setError(null);
    try {
      const parsed = parseCsv(text);
      if (!parsed.columns.length || !parsed.rows.length) {
        setError("Could not parse any rows from this file.");
        return;
      }
      setCsv(parsed);
      setMapping(autoDetectMapping(parsed.columns));
      setDatasetName(name);
    } catch {
      setError("Failed to parse the file as CSV.");
    }
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then((t) => loadText(t, file.name.replace(/\.csv$/i, "")));
  }

  async function useGoldSet() {
    setError(null);
    try {
      const resp = await fetch(`${import.meta.env.BASE_URL}hmdb_gold_set.csv`);
      const text = await resp.text();
      const parsed = parseCsv(text);
      // Headline = CURATION tier only (plan gold-set decision).
      const curation = parsed.rows.filter((r) => (r.match_level ?? "").toUpperCase() === "CURATION");
      setCsv({ columns: parsed.columns, rows: curation });
      setMapping({ nameColumn: "name", vocabColumns: { hmdb: "gt_hmdb" } });
      setDatasetName("HMDB gold set (CURATION)");
    } catch {
      setError("Could not load the built-in gold set.");
    }
  }

  const mappedVocabs = mapping ? Object.keys(mapping.vocabColumns) : [];
  const canRun = !!csv && !!mapping && !!mapping.nameColumn && mappedVocabs.length > 0;

  function setNameColumn(col: string) {
    if (!mapping) return;
    setMapping({ ...mapping, nameColumn: col });
  }

  function setVocabColumn(vocab: string, col: string) {
    if (!mapping) return;
    const next = { ...mapping.vocabColumns };
    if (col === IGNORE) delete next[vocab];
    else next[vocab] = col;
    setMapping({ ...mapping, vocabColumns: next });
  }

  async function run() {
    if (!csv || !mapping) return;
    setError(null);
    // Guard: name column cannot also feed a vocabulary.
    if (Object.values(mapping.vocabColumns).includes(mapping.nameColumn)) {
      setError("The name column cannot also be a ground-truth column.");
      return;
    }
    const { names, groundTruth, vocabularies, duplicatesMerged } = buildPayload(csv.rows, mapping);
    if (!names.length) {
      setError("No rows with a non-empty name were found.");
      return;
    }
    setDispatching(true);
    try {
      const { run_id } = await startBenchmark({
        names,
        groundTruth,
        vocabularies,
        datasetName: datasetName || "benchmark",
      });
      if (duplicatesMerged > 0) {
        // Non-blocking note is surfaced on the results page via the run record.
        console.info(`${duplicatesMerged} duplicate name(s) merged.`);
      }
      navigate(`/benchmark/runs/${run_id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start benchmark run.");
      setDispatching(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto py-8 px-4 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Benchmark</h1>
          <p className="text-neutral-500">
            Measure BioMapper accuracy against known-correct identifiers.
          </p>
        </div>
        <Button variant="outline" onClick={() => navigate("/benchmark/runs")}>
          Run history
        </Button>
      </div>

      <Alert>
        <AlertDescription>
          Hints are disabled on benchmark runs so scores reflect real resolution, not the
          answers you provide.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>1. Choose data</CardTitle>
          <CardDescription>
            Upload a wide-format CSV (a name column plus one <code>gt_&lt;vocab&gt;</code>{" "}
            column per vocabulary), or use the built-in HMDB gold set.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <input type="file" accept=".csv,text/csv" onChange={onFile} />
          <div className="text-sm text-neutral-500">or</div>
          <Button variant="secondary" onClick={useGoldSet}>
            Use built-in HMDB gold set (CURATION)
          </Button>
        </CardContent>
      </Card>

      {csv && mapping && (
        <Card>
          <CardHeader>
            <CardTitle>2. Map columns</CardTitle>
            <CardDescription>
              {csv.rows.length} row(s) · dataset “{datasetName}”
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="w-32 text-sm font-medium">Name column</span>
              <Select value={mapping.nameColumn} onValueChange={setNameColumn}>
                <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {csv.columns.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {VOCABULARIES.map((vocab) => (
              <div key={vocab} className="flex items-center gap-3">
                <span className="w-32 text-sm font-medium">gt_{vocab}</span>
                <Select
                  value={mapping.vocabColumns[vocab] ?? IGNORE}
                  onValueChange={(col) => setVocabColumn(vocab, col)}
                >
                  <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={IGNORE}>— not scored —</SelectItem>
                    {csv.columns.map((c) => (
                      <SelectItem key={c} value={c}>{c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
            {mappedVocabs.length === 0 && (
              <p className="text-sm text-amber-600">
                Map at least one vocabulary column to run a benchmark.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {error && (
        <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
      )}

      <Button disabled={!canRun || dispatching} onClick={run}>
        {dispatching ? "Starting…" : "Run benchmark"}
      </Button>
    </div>
  );
}
