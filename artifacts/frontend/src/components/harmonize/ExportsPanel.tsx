import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Loader2, Send } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Notice } from "@/components/harmonize/common";
import { EITL_PREVIEW_KEY } from "@/components/harmonize/ItemsPanel";
import { fetchExport, saveBlob, type ExportFormat, type ExportTable } from "@/lib/harmonize-export";
import { errorMessage } from "@/lib/harmonize";

const TABLES: Array<{ table: Exclude<ExportTable, "eitl_pairs">; label: string; what: string }> = [
  { table: "links", label: "Links", what: "Every link in both arms, with its basis, partners and flag." },
  { table: "groups", label: "Groups", what: "Every group in both arms, with its node, members and flag." },
  { table: "review", label: "Review entries", what: "Review queue, possible misses, withheld names, cross-node and identifier checks." },
  { table: "unresolved", label: "Unresolved rows", what: "Rows that resolved to nothing, errored, or found no node." },
];
const FORMATS: ExportFormat[] = ["csv", "tsv", "json"];

function skippedSentence(n: number): string {
  if (n === 0) return "Every flagged item is in the file.";
  return `${n} flagged item${n === 1 ? " was" : "s were"} left out: flagged review entries, unresolved rows and one-row groups have no pair to send.`;
}

/** Downloads, each with the caller's current flags, and the EITL pairs file (the handoff to expert review). */
export function ExportsPanel({ jobId, kind }: { jobId: string; kind: string }) {
  const many = kind === "harmonize_many";
  const [pending, setPending] = useState<string | null>(null);
  const [result, setResult] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [eitlFormat, setEitlFormat] = useState<"json" | "csv">("json");

  const preview = useQuery({
    queryKey: EITL_PREVIEW_KEY(jobId),
    queryFn: async () => {
      const r = await fetchExport(jobId, "eitl_pairs", "json");
      const body = JSON.parse(await r.blob.text());
      return { pairs: Array.isArray(body) ? body.length : null, skipped: r.skipped };
    },
    retry: 1,
  });

  const download = async (table: ExportTable, format: ExportFormat) => {
    const key = `${table}.${format}`;
    setPending(key);
    setResult(null);
    try {
      const r = await fetchExport(jobId, table, format);
      saveBlob(r.blob, r.filename);
      const extra = table === "eitl_pairs" && r.skipped != null ? ` ${skippedSentence(r.skipped)}` : "";
      setResult({ tone: "success", text: `Downloaded ${r.filename}.${extra}` });
      if (table === "eitl_pairs") void preview.refetch();
    } catch (e) {
      setResult({ tone: "danger", text: errorMessage(e) });
    } finally {
      setPending(null);
    }
  };

  return (
    <Card data-testid="exports-panel">
      <CardHeader>
        <CardTitle>Download results</CardTitle>
        <CardDescription>
          Every table carries the flag columns (flagged, flag_source, suggested) as they are now. A table that does not
          apply to this run downloads as a header with no rows.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="rounded border border-neutral-200" data-testid="export-tables">
          {TABLES.map((t) => {
            const empty = (many && t.table === "links") || (!many && t.table === "groups");
            return (
              <div key={t.table} className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-100 px-4 py-3 last:border-0">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-neutral-900">{t.label}</p>
                  <p className="text-xs text-neutral-500">
                    {t.what}
                    {empty ? ` Header only on ${many ? "many-cohort" : "two-cohort"} runs.` : ""}
                  </p>
                </div>
                <div className="flex gap-2" role="group" aria-label={`Download ${t.label}`}>
                  {FORMATS.map((f) => (
                    <Button
                      key={f}
                      variant="outline"
                      size="sm"
                      disabled={pending !== null}
                      onClick={() => void download(t.table, f)}
                      aria-label={`Download ${t.label} as ${f.toUpperCase()}`}
                      data-testid={`btn-export-${t.table}-${f}`}
                    >
                      {pending === `${t.table}.${f}` ? <Loader2 className="animate-spin" /> : <Download />} {f.toUpperCase()}
                    </Button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <section className="rounded border border-ph-navy/20 bg-ph-navy/5 p-4" data-testid="eitl-export" aria-labelledby="eitl-title">
          <h3 id="eitl-title" className="text-sm font-semibold text-neutral-900">EITL pairs file</h3>
          <p className="mt-1 text-sm text-neutral-700">
            The flagged {many ? "groups (n - 1 pairs per group of n rows)" : "links"}, in the columns the expert-in-the-loop
            pairs upload reads. Flag changes above show in the next download.
          </p>
          <p className="mt-2 text-sm text-neutral-800" data-testid="eitl-preview">
            {preview.isLoading
              ? "Counting the pairs..."
              : preview.isError
                ? `Couldn't count the pairs: ${errorMessage(preview.error)}`
                : preview.data
                  ? `${preview.data.pairs ?? "Some"} pair${preview.data.pairs === 1 ? "" : "s"} in the file now. ${
                      preview.data.skipped != null ? skippedSentence(preview.data.skipped) : ""
                    }`
                  : null}
            {preview.isFetching && !preview.isLoading && <span className="ml-1 text-xs text-neutral-500">(updating)</span>}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-6">
            <RadioGroup
              value={eitlFormat}
              onValueChange={(v) => setEitlFormat(v as "json" | "csv")}
              className="flex gap-4"
              aria-label="EITL pairs file format"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="json" id="eitl-json" />
                <Label htmlFor="eitl-json" className="cursor-pointer font-normal">JSON (recommended)</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="csv" id="eitl-csv" />
                <Label htmlFor="eitl-csv" className="cursor-pointer font-normal">CSV</Label>
              </div>
            </RadioGroup>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void download("eitl_pairs", eitlFormat)} disabled={pending !== null} data-testid="btn-export-eitl">
                {pending?.startsWith("eitl_pairs") ? <Loader2 className="animate-spin" /> : <Download />} Download EITL pairs ({eitlFormat.toUpperCase()})
              </Button>
              <Button variant="outline" disabled aria-describedby="eitl-send-note" data-testid="btn-send-eitl">
                <Send /> Send to EITL
              </Button>
            </div>
          </div>
          <p className="mt-2 text-xs text-neutral-600">
            JSON is the exact handoff. In CSV, cells that could start a spreadsheet formula are prefixed with an apostrophe
            (formula-neutralized). TSV is not offered: the expert-in-the-loop upload does not read it.
          </p>
          <p id="eitl-send-note" className="mt-1 text-xs text-neutral-600">
            Send to EITL is coming: it will start an expert-review campaign from these pairs. For now, download the file and
            upload it in the expert-in-the-loop app.
          </p>
        </section>

        {result && <Notice tone={result.tone} testId="export-result">{result.text}</Notice>}
      </CardContent>
    </Card>
  );
}
