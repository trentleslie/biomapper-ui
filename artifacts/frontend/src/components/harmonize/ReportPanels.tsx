import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Loader2, Send } from "lucide-react";
import type { HarmonizeRunStatus } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  EXPORT_FORMATS,
  EXPORT_TABLES,
  type ExportFormat,
  type ExportTable,
  apiErrorMessage,
  entityLabel,
  fetchExport,
  plural,
  saveBlob,
} from "@/lib/harmonize";
import {
  ARMS,
  armSummary,
  diffView,
  excluded,
  identifierChecks,
  identifierSkipped,
  isMany,
  nameLinking,
  pins,
  reportCategory,
  statusAndGrade,
  warnings,
  type Report,
} from "@/lib/harmonize-report";
import { Dock } from "./DetailPanels";
import { ErrorBox, SectionTitle, ToneBadge } from "./primitives";
import { EITL_PREVIEW_KEY } from "./ItemsView";

// ---------------------------------------------------------------------------
// The strip over the table: both arms side by side, and how they differ
// ---------------------------------------------------------------------------

const DIFF_SHORT: Record<string, string> = {
  "Only the names-only arm found": "Names-only arm only",
  "Only the identifier arm found": "Identifier arm only",
  "Both arms found": "Both arms",
  "Groups whose membership changed": "Membership changed",
};

export function ArmStrip({ report, onOpenDetails }: { report: Report; onOpenDetails: () => void }) {
  const diff = diffView(report);
  const sg = statusAndGrade(report);
  return (
    <div className="grid grid-cols-1 gap-2 lg:grid-cols-[1fr_1fr_auto]" data-testid="arm-strip">
      {ARMS.map((arm) => {
        const s = armSummary(report, arm);
        return (
          <section key={arm} aria-label={`${arm === "names_only" ? "Names-only" : "Identifier"} arm`} className="rounded border border-neutral-200 bg-white px-3 py-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">{arm === "names_only" ? "Names-only arm" : "Identifier arm"}</p>
            {s.skipped ? (
              <p className="mt-1 text-xs text-neutral-700" data-testid={`arm-skipped-${arm}`}>
                <ToneBadge tone="warning">Skipped</ToneBadge> {s.reason ?? "The report gives no reason."}
              </p>
            ) : (
              <>
                <p className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-neutral-700">
                  {s.headline.map((c) => (
                    <span key={c.label}>
                      {c.label} <span className="tabular font-semibold text-neutral-900">{c.value.toLocaleString()}</span>
                    </span>
                  ))}
                </p>
                {(() => {
                  const parts = s.perCohort.map((pc) => {
                    const n = pc.counts.filter((c) => ["Unresolved", "Errored", "No node"].includes(c.label)).reduce((a, c) => a + c.value, 0);
                    return `${pc.cohort} ${n}`;
                  });
                  const text = `Not ${isMany(report) ? "grouped" : "resolved"}: ${parts.join(" · ")}`;
                  return (
                    <p className="mt-0.5 truncate text-[11px] text-neutral-500" title={text}>
                      {text}
                    </p>
                  );
                })()}
              </>
            )}
          </section>
        );
      })}
      <div className="flex flex-col gap-0.5 rounded border border-neutral-200 bg-white px-3 py-2 lg:max-w-xs">
        {diff && (
          <p className="text-xs text-neutral-700" data-testid="diff-strip">
            {diff.counts.map((c, i) => (
              <span key={c.label}>
                {i > 0 && " · "}
                {DIFF_SHORT[c.label] ?? c.label}{" "}
                <span className="tabular font-semibold text-neutral-900">{c.value}</span>
              </span>
            ))}
          </p>
        )}
        {nameLinking(report) && (
          <p className="text-xs text-neutral-700" title={nameLinking(report)?.reason ?? undefined}>
            Name links <span className="font-semibold">{nameLinking(report)?.enabled ? "on" : "off"}</span>
            {nameLinking(report)?.decidedBy && <> (decided by {nameLinking(report)?.decidedBy})</>}
          </p>
        )}
        {sg.status && (
          <p className="text-xs text-neutral-700">
            Status <span className="font-semibold">{sg.status}</span>
            {sg.grade && <> · {sg.grade}</>}
          </p>
        )}
        <Button variant="link" size="sm" className="h-auto self-start text-xs" onClick={onOpenDetails}>
          All run details
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run details: everything the report says about the run
// ---------------------------------------------------------------------------

export function RunDetailsPanel({ run, report, onClose }: { run: HarmonizeRunStatus; report: Report; onClose: () => void }) {
  const nl = nameLinking(report);
  const diff = diffView(report);
  const ws = warnings(report);
  const ex = excluded(report);
  const sg = statusAndGrade(report);
  const checks = identifierChecks(report);
  const skip = identifierSkipped(report);
  const category = reportCategory(report);
  const pinList = pins(report, { kgBuild: run.kgBuild, kgVerified: run.kgVerified });

  return (
    <Dock title="Run details" onClose={onClose} testId="details-panel">
      <div className="space-y-5 text-sm">
        <section>
          <SectionTitle>Run</SectionTitle>
          <dl className="grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            <dt className="text-neutral-500">Entity</dt>
            <dd>{entityLabel(run.entity)}</dd>
            <dt className="text-neutral-500">Category</dt>
            <dd>{category ?? "Not reported"}</dd>
            <dt className="text-neutral-500">Cohorts</dt>
            <dd>{(run.cohorts ?? []).map((c) => `${c.label} (${c.rows} rows)`).join(", ") || (run.labels ?? []).join(", ")}</dd>
            {sg.status && (
              <>
                <dt className="text-neutral-500">Status</dt>
                <dd data-testid="report-status">{sg.status}</dd>
              </>
            )}
            {sg.grade && (
              <>
                <dt className="text-neutral-500">Grade</dt>
                <dd data-testid="report-grade">{sg.grade}</dd>
              </>
            )}
          </dl>
        </section>

        <section>
          <SectionTitle>Name linking</SectionTitle>
          {nl ? (
            <div data-testid="name-linking">
              <p className="text-xs font-medium text-neutral-900">
                {nl.enabled === true ? "On" : nl.enabled === false ? "Off" : "Not stated"}
                {nl.decidedBy && <span className="font-normal text-neutral-500"> (decided by {nl.decidedBy})</span>}
              </p>
              <p className="mt-1 text-xs text-neutral-700">{nl.reason ?? "The report gives no reason."}</p>
            </div>
          ) : (
            <p className="text-xs text-neutral-500">The report does not describe name linking.</p>
          )}
        </section>

        <section>
          <SectionTitle>The two arms</SectionTitle>
          <div className="grid grid-cols-1 gap-2">
            {ARMS.map((arm) => {
              const s = armSummary(report, arm);
              return (
                <div key={arm} className="rounded border border-neutral-200 p-2">
                  <p className="text-xs font-semibold text-neutral-900">{arm === "names_only" ? "Names-only arm" : "Identifier arm"}</p>
                  {s.skipped ? (
                    <p className="text-xs text-neutral-700">Skipped: {s.reason ?? skip.reason ?? "the report gives no reason."}</p>
                  ) : (
                    <>
                      <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-neutral-700">
                        {s.headline.map((c) => (
                          <span key={c.label}>
                            {c.label} <span className="tabular font-semibold">{c.value}</span>
                          </span>
                        ))}
                      </p>
                      <table className="mt-1 w-full text-xs">
                        <thead>
                          <tr className="text-left text-[11px] text-neutral-500">
                            <th className="py-0.5 pr-2 font-medium">Cohort</th>
                            {s.perCohort[0]?.counts.map((c) => (
                              <th key={c.label} className="py-0.5 pr-2 text-right font-medium">
                                {c.label}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {s.perCohort.map((pc) => (
                            <tr key={pc.cohort} className="border-t border-neutral-100">
                              <td className="py-0.5 pr-2">{pc.cohort}</td>
                              {pc.counts.map((c) => (
                                <td key={c.label} className="tabular py-0.5 pr-2 text-right">
                                  {c.value}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {diff && (
          <section data-testid="diff-section">
            <SectionTitle>How the arms differ</SectionTitle>
            <div className="space-y-2">
              {diff.sets.map((set) => (
                <details key={set.key} className="rounded border border-neutral-200 p-2" open={set.key !== "both" && set.entries.length > 0}>
                  <summary className="cursor-pointer text-xs font-medium text-neutral-900">
                    {set.label}: <span className="tabular">{set.entries.length}</span>
                  </summary>
                  {set.entries.length === 0 ? (
                    <p className="mt-1 text-xs text-neutral-500">None.</p>
                  ) : (
                    <ul className="mt-1 max-h-48 scroll-visible text-xs text-neutral-700">
                      {set.entries.map((e, i) => (
                        <li key={`${e}-${i}`} className="py-0.5">
                          {e}
                        </li>
                      ))}
                    </ul>
                  )}
                </details>
              ))}
            </div>
          </section>
        )}

        {checks.length > 0 && (
          <section>
            <SectionTitle>One-sided identifier checks</SectionTitle>
            <p className="mb-1 text-xs text-neutral-600">
              Codes of a vocabulary only one cohort declares, compared with the row's names-only result. Disagreements are in the review queue and in the Items view as review items.
            </p>
            <div className="max-h-56 scroll-visible rounded border border-neutral-200">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-neutral-50 text-left text-[11px] text-neutral-500">
                  <tr>
                    <th className="px-2 py-1 font-medium">Row</th>
                    <th className="px-2 py-1 font-medium">Code</th>
                    <th className="px-2 py-1 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {checks.map((c, i) => (
                    <tr key={i} className="border-t border-neutral-100">
                      <td className="px-2 py-1">
                        {String(c.cohort ?? "")} {String(c.key ?? "")} {String(c.name ?? "")}
                      </td>
                      <td className="px-2 py-1">
                        {String(c.vocabulary ?? "")} {String(c.code ?? "")}
                      </td>
                      <td className="px-2 py-1">{String(c.status ?? "").replace(/_/g, " ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section data-testid="excluded-section">
          <SectionTitle>Excluded rows</SectionTitle>
          {ex.every((c) => c.rows.length === 0) ? (
            <p className="text-xs text-neutral-700">No rows were excluded from any cohort.</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {ex.map((c) => (
                <li key={c.cohort}>
                  <span className="font-medium">{c.cohort}</span>:{" "}
                  {c.rows.length === 0 ? "none excluded" : c.rows.map((r) => `row ${r.key}${r.reason ? ` (${r.reason})` : ""}`).join(", ")}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section data-testid="warnings-section">
          <SectionTitle>Warnings</SectionTitle>
          {ws.length === 0 ? (
            <p className="text-xs text-neutral-700">The run reported no warnings.</p>
          ) : (
            <ul className="space-y-1">
              {ws.map((w, i) => (
                <li key={i} className="rounded border border-warning-border bg-warning-bg p-2 text-xs text-neutral-900">
                  {w}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section data-testid="pins-section">
          <SectionTitle>Version pins</SectionTitle>
          {pinList.length === 0 ? (
            <p className="text-xs text-neutral-500">This run recorded no version pins.</p>
          ) : (
            <dl className="grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
              {pinList.map((p) => (
                <div key={p.label} className="contents">
                  <dt className="text-neutral-500">{p.label}</dt>
                  <dd className="break-words">{p.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      </div>
    </Dock>
  );
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

const TABLE_LABELS: Record<string, string> = {
  links: "Links",
  groups: "Groups",
  review: "Review",
  unresolved: "Unresolved",
};

export function ExportPanel({ run, many, flaggedTotal, onClose }: { run: HarmonizeRunStatus; many: boolean; flaggedTotal: number | null; onClose: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [eitlFormat, setEitlFormat] = useState<"json" | "csv">("json");
  const [lastEitl, setLastEitl] = useState<{ filename: string; skipped: number | null } | null>(null);

  // How many flagged items the pairs file leaves out, read from the export's own header and refreshed whenever
  // a flag changes (ItemsView invalidates this key).
  const preview = useQuery({
    queryKey: [...EITL_PREVIEW_KEY(run.jobId), flaggedTotal],
    queryFn: async () => {
      const res = await fetchExport(run.jobId, "eitl_pairs", "json");
      let pairs = 0;
      try {
        const rows = JSON.parse(await res.blob.text());
        pairs = Array.isArray(rows) ? rows.length : 0;
      } catch {
        pairs = 0;
      }
      return { skipped: res.skipped, pairs };
    },
  });

  async function download(table: ExportTable, format: ExportFormat) {
    const key = `${table}.${format}`;
    setBusy(key);
    setError(null);
    try {
      const res = await fetchExport(run.jobId, table, format);
      saveBlob(res.blob, res.filename);
      if (table === "eitl_pairs") setLastEitl({ filename: res.filename, skipped: res.skipped });
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dock title="Export" onClose={onClose} testId="export-panel">
      <div className="space-y-5 text-sm">
        <section aria-labelledby="eitl-heading" className="rounded border border-ph-navy/30 bg-neutral-50 p-3">
          <h3 id="eitl-heading" className="text-sm font-semibold text-neutral-900">
            Pairs for expert review (EITL)
          </h3>
          <p className="mt-1 text-xs text-neutral-700">
            Holds exactly the flagged links and flagged groups (a group of n rows gives n minus 1 pairs), in the columns the expert-in-the-loop pairs upload reads.
          </p>
          <div className="mt-2 text-xs text-neutral-800" aria-live="polite" data-testid="eitl-preview">
            {preview.isLoading ? (
              <span className="flex items-center gap-1 text-neutral-500">
                <Loader2 aria-hidden className="h-3 w-3 animate-spin" /> Counting the pairs
              </span>
            ) : preview.isError ? (
              <span className="text-danger">{apiErrorMessage(preview.error)}</span>
            ) : preview.data ? (
              <span>
                {plural(preview.data.pairs, "pair")} from {flaggedTotal === null ? "the" : plural(flaggedTotal, "flagged item")}
                {flaggedTotal === null ? " flagged items" : ""}.{" "}
                {preview.data.skipped !== null && (
                  <span data-testid="eitl-skipped">
                    {plural(preview.data.skipped, "flagged item")} left out: flagged review and unresolved items and one-row groups give no pair.
                  </span>
                )}
              </span>
            ) : null}
          </div>
          <fieldset className="mt-3">
            <legend className="text-xs font-medium text-neutral-600">Format</legend>
            <div className="mt-1 flex gap-4 text-sm">
              <label className="flex items-center gap-1.5">
                <input type="radio" name="eitl-format" value="json" checked={eitlFormat === "json"} onChange={() => setEitlFormat("json")} />
                JSON (recommended)
              </label>
              <label className="flex items-center gap-1.5">
                <input type="radio" name="eitl-format" value="csv" checked={eitlFormat === "csv"} onChange={() => setEitlFormat("csv")} />
                CSV
              </label>
            </div>
            <p className="mt-1 text-xs text-neutral-600">
              JSON is the exact handoff to EITL. In CSV, cells that could start a spreadsheet formula are prefixed with an apostrophe, so the text can differ. TSV is not offered: the EITL upload does not read it.
            </p>
          </fieldset>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button onClick={() => void download("eitl_pairs", eitlFormat)} disabled={busy !== null}>
              {busy === `eitl_pairs.${eitlFormat}` ? <Loader2 aria-hidden className="animate-spin" /> : <Download aria-hidden />}
              Download EITL pairs ({eitlFormat.toUpperCase()})
            </Button>
            <Button variant="secondary" disabled aria-describedby="send-eitl-note">
              <Send aria-hidden /> Send to EITL
            </Button>
          </div>
          <p id="send-eitl-note" className="mt-1 text-xs text-neutral-500">
            Coming soon: send the pairs straight to an expert-review campaign. For now, download the file and upload it in EITL.
          </p>
          {lastEitl && (
            <p role="status" className="mt-2 rounded border border-success-border bg-success-bg p-2 text-xs text-success" data-testid="eitl-downloaded">
              Saved {lastEitl.filename}.{" "}
              {lastEitl.skipped !== null
                ? `${plural(lastEitl.skipped, "flagged item")} ${lastEitl.skipped === 1 ? "was" : "were"} left out of the file.`
                : "The server did not say how many flagged items were left out."}
            </p>
          )}
        </section>

        <section>
          <SectionTitle>Tables</SectionTitle>
          <p className="mb-2 text-xs text-neutral-600">
            Every item of the run in both arms, with its flag columns (flagged, flag_source, suggested).{" "}
            {many ? "Links do not apply to many-cohort runs" : "Groups do not apply to two-cohort runs"}: that table downloads as its header with no rows.
          </p>
          <table className="w-full text-sm">
            <tbody>
              {EXPORT_TABLES.map((table) => {
                const na = (table === "groups" && !many) || (table === "links" && many);
                return (
                  <tr key={table} className="border-t border-neutral-100">
                    <th scope="row" className={cn("py-1.5 pr-2 text-left font-medium", na ? "text-neutral-400" : "text-neutral-900")}>
                      {TABLE_LABELS[table]}
                    </th>
                    {EXPORT_FORMATS.map((format) => (
                      <td key={format} className="py-1.5 pr-1">
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy !== null}
                          aria-label={`Download ${TABLE_LABELS[table].toLowerCase()} as ${format.toUpperCase()}`}
                          onClick={() => void download(table, format)}
                        >
                          {busy === `${table}.${format}` ? <Loader2 aria-hidden className="animate-spin" /> : <Download aria-hidden />}
                          {format.toUpperCase()}
                        </Button>
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
        {error && <ErrorBox title="The download failed" message={error} />}
      </div>
    </Dock>
  );
}
