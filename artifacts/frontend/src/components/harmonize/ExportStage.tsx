import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Download, Loader2, Send } from "lucide-react";
import type { HarmonizeRunStatus } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { useEnv } from "@/contexts/env-context";
import { cn } from "@/lib/utils";
import {
  EXPORT_FORMATS,
  EXPORT_TABLES,
  eitlPairs,
  errorMessage,
  plural,
  tableApplies,
  type ExportFormat,
  type ExportTable,
} from "@/lib/harmonize";
import { fetchExport, saveFile } from "@/lib/harmonize-export";
import { Mono, Note, Panel } from "./common";

const PREVIEW_ROWS = 50;
import { stageHref } from "./StageRail";

const TABLE_TEXT: Record<(typeof EXPORT_TABLES)[number], { title: string; blurb: string }> = {
  links: { title: "Links", blurb: "Every link between the two cohorts, one row per link per arm." },
  groups: { title: "Groups", blurb: "Every group of rows that share a node, in both arms." },
  review: { title: "Review", blurb: "Review entries: identifier checks, possible misses, withheld name matches, cross-node entries." },
  unresolved: { title: "Unresolved", blurb: "Rows that resolved to nothing or errored, per cohort." },
};

const FORMAT_LABEL: Record<ExportFormat, string> = { csv: "CSV", tsv: "TSV", json: "JSON" };

function useDownloader(jobId: string) {
  const { env } = useEnv();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [skipped, setSkipped] = useState<number | null>(null);
  const download = async (table: ExportTable, format: ExportFormat) => {
    const key = `${table}.${format}`;
    setBusy(key);
    setError(null);
    try {
      const file = await fetchExport(jobId, table, format, { env });
      saveFile(file);
      if (table === "eitl_pairs") setSkipped(file.skipped);
    } catch (err) {
      setError({ key, message: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, skipped, download, env };
}

/**
 * The pairs the EITL file holds now (the JSON export itself, so it is exactly what a download gives), and how many
 * flagged items it leaves out (read from the X-Harmonize-Skipped-One-Sided header). Refetched after any flag change.
 */
function useEitlPreview(jobId: string, env: string) {
  return useQuery({
    queryKey: ["harmonize-eitl-preview", jobId],
    queryFn: async () => {
      const file = await fetchExport(jobId, "eitl_pairs", "json", { env });
      return { pairs: eitlPairs(await file.blob.text()), skipped: file.skipped };
    },
    staleTime: 0,
  });
}

/** Export stage: the EITL pairs file first (JSON by default), then every item table in every format. */
export function ExportStage({ run, flaggedTotal }: { run: HarmonizeRunStatus; flaggedTotal: number | null }) {
  const { busy, error, skipped, download, env } = useDownloader(run.jobId);
  const [eitlFormat, setEitlFormat] = useState<"json" | "csv">("json");
  const preview = useEitlPreview(run.jobId, env);
  const shownSkipped = skipped ?? preview.data?.skipped ?? null;
  const pairs = preview.data?.pairs ?? null;
  const twoCohort = run.kind !== "harmonize_many";

  return (
    <div className="space-y-6">
      <Panel
        id="eitl"
        title="Pairs file for expert-in-the-loop (EITL), the expert review app"
        description="The flagged links and flagged groups, as pairs EITL reads. Upload it to an EITL campaign."
      >
        <div className="space-y-4">
          <div className="space-y-1 text-sm text-neutral-700" data-testid="eitl-preview" aria-live="polite">
            {preview.isLoading ? (
              <span className="text-neutral-500">Counting the pairs</span>
            ) : preview.isError ? (
              <span className="text-danger">{errorMessage(preview.error, "The pairs could not be counted.")}</span>
            ) : (
              <>
                <p data-testid="eitl-counts">
                  {flaggedTotal != null && <span>{plural(flaggedTotal, "item")} flagged in this run. </span>}
                  {pairs && <span>The file holds {plural(pairs.length, "pair")}. </span>}
                  {shownSkipped != null && shownSkipped > 0 && (
                    <span>
                      {plural(shownSkipped, "flagged item")} {shownSkipped === 1 ? "gives" : "give"} no pair.
                    </span>
                  )}
                </p>
                {flaggedTotal != null && flaggedTotal > 0 && pairs && (
                  <p className="text-xs text-neutral-500" data-testid="eitl-counts-why">
                    These numbers need not add up. A flagged link gives one pair, and a link found by both arms is
                    written once. A flagged group gives one pair for each of its rows after the first. Flagged review
                    entries, unresolved rows and groups of one row have no second side, so they give none.
                  </p>
                )}
              </>
            )}
          </div>
          {pairs && pairs.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-neutral-700">
                In the file now{pairs.length > PREVIEW_ROWS ? ` (the first ${PREVIEW_ROWS} of ${pairs.length.toLocaleString()})` : ""}
              </p>
              <ol className="scroll-visible max-h-64 divide-y divide-neutral-100 rounded border border-neutral-200 text-sm" data-testid="eitl-pairs-preview">
                {pairs.slice(0, PREVIEW_ROWS).map((p, i) => (
                  <li key={i} className="px-3 py-1.5">
                    <span className="text-neutral-900">{p.sourceText}</span>{" "}
                    <Mono className="text-neutral-500">
                      ({p.sourceDataset} {p.sourceId})
                    </Mono>{" "}
                    <span className="text-neutral-500">with</span> <span className="text-neutral-900">{p.targetText}</span>{" "}
                    <Mono className="text-neutral-500">
                      ({p.targetDataset} {p.targetId})
                    </Mono>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {flaggedTotal === 0 && (
            <Note tone="info" title="Nothing is flagged yet" testId="eitl-empty">
              The pairs file holds only flagged links and groups, so it is empty for now.{" "}
              <Link href={stageHref(run.jobId, "review") + "?view=flags"} className="font-medium text-ph-navy underline-offset-2 hover:underline">
                Flag items in Review and flag
              </Link>
              .
            </Note>
          )}
          {shownSkipped != null && flaggedTotal !== 0 && (
            <Note tone={shownSkipped > 0 ? "warning" : "info"} title="Left out of the pairs file" testId="eitl-skipped">
              {shownSkipped === 0
                ? "No flagged item is left out: every flagged item gives a pair."
                : `${plural(shownSkipped, "flagged item")} ${shownSkipped === 1 ? "is" : "are"} left out. Flagged review entries, unresolved rows and one-row items have no second side, so they give no pair.`}
            </Note>
          )}

          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-neutral-700">Format</legend>
            <div className="flex flex-wrap gap-3">
              {(["json", "csv"] as const).map((f) => (
                <label
                  key={f}
                  className={cn(
                    "flex cursor-pointer items-start gap-2 rounded border px-3 py-2 text-sm",
                    eitlFormat === f ? "border-ph-navy bg-neutral-100" : "border-neutral-200 bg-white",
                  )}
                >
                  <input type="radio" name="eitl-format" value={f} aria-label={f === "json" ? "JSON (recommended)" : "CSV"} checked={eitlFormat === f} onChange={() => setEitlFormat(f)} className="mt-1 accent-ph-navy" />
                  <span>
                    <span className="font-medium text-neutral-900">{f === "json" ? "JSON (recommended)" : "CSV"}</span>
                    <span className="block text-xs text-neutral-500">
                      {f === "json"
                        ? "The exact handoff: values are written as they are."
                        : "For spreadsheets: cells that could start a formula are neutralized."}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <p className="text-xs text-neutral-500">TSV is not offered: the expert-in-the-loop upload does not read TSV.</p>
          </fieldset>

          <div className="flex flex-wrap items-center gap-3">
            <Button size="lg" onClick={() => download("eitl_pairs", eitlFormat)} disabled={busy !== null}>
              {busy === `eitl_pairs.${eitlFormat}` ? <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" /> : <Download aria-hidden />}
              Download EITL pairs ({FORMAT_LABEL[eitlFormat]})
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="lg" disabled aria-describedby="send-eitl-note">
                <Send aria-hidden /> Send to EITL
              </Button>
              <span id="send-eitl-note" className="text-xs text-neutral-500">
                Coming soon: send the pairs straight to an EITL campaign.
              </span>
            </div>
          </div>
          {error?.key.startsWith("eitl_pairs") && (
            <Note tone="danger" title="The download failed">
              {error.message}
            </Note>
          )}
        </div>
      </Panel>

      <Panel id="tables" title="Result tables" description="Every table carries the flag columns: flagged, flag_source and suggested.">
        <div className="space-y-3">
          {twoCohort && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-neutral-200 bg-neutral-50 px-4 py-3" data-testid="matched-pairs">
              <div className="min-w-0">
                <p className="font-medium text-neutral-900">Matched pairs (links table)</p>
                <p className="text-xs text-neutral-500">
                  The list of matches: one row per link, with both rows' keys and names, its basis and its flag. A pair
                  found by both arms appears once for each arm.
                </p>
              </div>
              <Button onClick={() => download("links", "csv")} disabled={busy !== null}>
                {busy === "links.csv" ? <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" /> : <Download aria-hidden />}
                Download matched pairs (CSV)
              </Button>
            </div>
          )}
          <div className="scroll-visible rounded border border-neutral-200">
            <table className="w-full text-sm">
              <caption className="sr-only">Result tables to download</caption>
              <thead className="bg-neutral-50">
                <tr className="border-b border-neutral-200">
                  <th scope="col" className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-neutral-500">Table</th>
                  <th scope="col" className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-neutral-500">Download</th>
                </tr>
              </thead>
              <tbody>
                {EXPORT_TABLES.map((table) => {
                  const applies = tableApplies(table, run.kind);
                  return (
                    <tr key={table} className="border-b border-neutral-100 last:border-b-0">
                      <td className="px-4 py-3 align-top">
                        <p className="font-medium text-neutral-900">{TABLE_TEXT[table].title}</p>
                        <p className="text-xs text-neutral-500">{TABLE_TEXT[table].blurb}</p>
                        {!applies && (
                          <p className="mt-1 text-xs text-neutral-500">
                            {table === "groups" ? "Two-cohort runs have links, not groups" : "Many-cohort runs have groups, not links"}: this file has only its header row.
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 align-top">
                        <div className="flex flex-wrap gap-2">
                          {EXPORT_FORMATS.map((format) => (
                            <Button
                              key={format}
                              variant="secondary"
                              size="sm"
                              disabled={busy !== null}
                              onClick={() => download(table, format)}
                              aria-label={`Download ${TABLE_TEXT[table].title.toLowerCase()} table as ${FORMAT_LABEL[format]}`}
                            >
                              {busy === `${table}.${format}` ? <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" /> : <Download aria-hidden />}
                              {FORMAT_LABEL[format]}
                            </Button>
                          ))}
                        </div>
                        {error?.key.startsWith(`${table}.`) && (
                          <p role="alert" className="mt-2 text-sm text-danger">
                            {error.message}
                          </p>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </Panel>
    </div>
  );
}
