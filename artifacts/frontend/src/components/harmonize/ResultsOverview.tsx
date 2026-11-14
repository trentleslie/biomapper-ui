import type { HarmonizeRunStatus } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FieldTooltip } from "@/components/field-tooltip";
import { FactList, Notice } from "@/components/harmonize/common";
import {
  BASIS_LABEL,
  armDiff,
  armSummary,
  excludedRows,
  nameLinking,
  versionPins,
  warnings,
  type ArmSummary,
  type Report,
} from "@/lib/harmonize";

/**
 * The report at a glance, in the order the entity-resolution dashboard uses: headline numbers, then the two arms
 * side by side, how they differ, and the run's facts (name linking, status and grade, warnings, excluded rows,
 * version pins).
 */
export function ResultsOverview({ report, run }: { report: Report; run: HarmonizeRunStatus }) {
  const many = report.kind === "harmonize_many";
  const names = armSummary(report, "names_only");
  const ident = armSummary(report, "identifier");
  const unit = many ? "groups" : "links";
  const skippedReason = typeof report.identifier_skipped_reason === "string" ? report.identifier_skipped_reason : null;
  const fromJobs = report.kind === "harmonize_results";

  return (
    <div className="space-y-6" data-testid="results-overview">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label={`Names-only ${unit}`} value={names?.main} testId="stat-names-only" />
        <Stat
          label={`Identifier ${unit}`}
          value={ident?.main}
          fallback={fromJobs ? "not run" : "skipped"}
          testId="stat-identifier"
        />
        <Stat label="Cohorts" value={(run.labels ?? []).length} testId="stat-cohorts" />
        {many ? (
          <Stat label="Report status" text={statusGrade(report).status} testId="stat-status" />
        ) : (
          <Stat
            label="Rows in the cohorts"
            value={(run.cohorts ?? []).reduce((s, c) => s + c.rows, 0) || undefined}
            testId="stat-rows"
          />
        )}
      </div>

      {many && <StatusGrade report={report} />}

      <Card data-testid="arms-card">
        <CardHeader>
          <CardTitle className="flex items-center">
            Names-only arm and identifier arm
            <FieldTooltip label="What the two arms are">
              Every run maps the cohorts twice. The names-only arm uses the analyte names alone; the identifier arm also
              sends the identifier columns both cohorts declare. Comparing them shows what the identifiers changed.
            </FieldTooltip>
          </CardTitle>
          <CardDescription>
            {many ? "Groups are rows from different cohorts placed on the same knowledge-graph node." : "Links pair a row of one cohort with a row of the other."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-6 lg:grid-cols-2">
            <ArmColumn title="Names-only arm" summary={names} unit={unit} many={many} />
            {ident ? (
              <ArmColumn title="Identifier arm" summary={ident} unit={unit} many={many} />
            ) : (
              <div className="space-y-2" data-testid="arm-identifier-skipped">
                <h3 className="text-sm font-semibold text-neutral-900">Identifier arm</h3>
                {fromJobs ? (
                  <Notice tone="info" title="Not part of this run">
                    A run built from finished mapping jobs has only the names-only arm: the jobs were already mapped,
                    so nothing is mapped again with identifiers.
                  </Notice>
                ) : (
                  <Notice tone="warning" title="Skipped">
                    {skippedReason ?? "The report gives no reason."}
                  </Notice>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <DiffCard report={report} />

      <RunFacts report={report} run={run} />
    </div>
  );
}

function Stat({ label, value, text, fallback = "none", testId }: {
  label: string;
  value?: number | null;
  text?: string;
  fallback?: string;
  testId?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-xs font-medium uppercase tracking-wider text-neutral-500">{label}</p>
        <div className="text-2xl font-semibold tabular-nums text-neutral-900" data-testid={testId}>
          {text ?? (value == null ? fallback : value.toLocaleString())}
        </div>
      </CardContent>
    </Card>
  );
}

function statusGrade(report: Report): { status: string; grade: string } {
  return {
    status: typeof report.status === "string" ? report.status : "not reported",
    grade: typeof report.grade === "string" ? report.grade : "not reported",
  };
}

function StatusGrade({ report }: { report: Report }) {
  const { status, grade } = statusGrade(report);
  const publishable = grade === "publishable";
  return (
    <Notice
      tone={status === "ok" && publishable ? "success" : status === "failed" ? "danger" : "warning"}
      title={`Status: ${status}. Grade: ${grade}.`}
      testId="status-grade"
    >
      {publishable
        ? "This run's results are fit for publication."
        : "Treat these results as a working draft for review, not as publication results."}
    </Notice>
  );
}

function ArmColumn({ title, summary, unit, many }: { title: string; summary: ArmSummary | null; unit: string; many: boolean }) {
  if (!summary) {
    return (
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-neutral-900">{title}</h3>
        <p className="text-sm text-neutral-500">This arm is not in the report.</p>
      </div>
    );
  }
  return (
    <div className="space-y-4" data-testid={`arm-${summary.arm}`}>
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-neutral-900">{title}</h3>
        <p className="text-sm text-neutral-700">
          <span className="text-xl font-semibold tabular-nums text-neutral-900">{summary.main.toLocaleString()}</span> {unit}
        </p>
      </div>
      <table className="w-full text-sm">
        <tbody>
          {summary.facts.map((f) => (
            <tr key={f.label} className="border-b border-neutral-100 last:border-0">
              <td className="py-1 text-neutral-500">
                {f.label}
                {f.hint && <span className="ml-1 text-xs text-neutral-400">({f.hint})</span>}
              </td>
              <td className="py-1 text-right font-mono tabular-nums">{f.value.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {summary.byBasis.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-neutral-500">Links by basis</p>
          <div className="flex flex-wrap gap-1.5">
            {summary.byBasis.map((b) => (
              <Badge key={b.basis} variant="outline" title={BASIS_LABEL[b.basis] ?? b.basis}>
                <span className="font-mono">{b.basis}</span> {b.count}
              </Badge>
            ))}
          </div>
        </div>
      )}
      <div>
        <p className="mb-1 text-xs font-medium text-neutral-500">Per cohort</p>
        <table className="w-full text-sm" data-testid={`arm-${summary.arm}-cohorts`}>
          <thead>
            <tr className="border-b text-left text-xs text-neutral-500">
              <th className="py-1 font-normal">Cohort</th>
              <th className="py-1 text-right font-normal">Rows</th>
              <th className="py-1 text-right font-normal">{many ? "Grouped" : "Linked"}</th>
              <th className="py-1 text-right font-normal">Unresolved</th>
              {many && <th className="py-1 text-right font-normal">No node</th>}
              <th className="py-1 text-right font-normal">Errored</th>
            </tr>
          </thead>
          <tbody>
            {summary.cohorts.map((c) => (
              <tr key={c.label} className="border-b border-neutral-100 last:border-0">
                <td className="max-w-[10rem] truncate py-1 font-mono text-xs" title={c.label}>{c.label}</td>
                <td className="py-1 text-right font-mono tabular-nums">{c.total}</td>
                <td className="py-1 text-right font-mono tabular-nums">{c.placed}</td>
                <td className="py-1 text-right font-mono tabular-nums">{c.unresolved}</td>
                {many && <td className="py-1 text-right font-mono tabular-nums">{c.noNode}</td>}
                <td className="py-1 text-right font-mono tabular-nums">{c.errored}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DiffCard({ report }: { report: Report }) {
  const diff = armDiff(report);
  return (
    <Card data-testid="diff-card">
      <CardHeader>
        <CardTitle>How the arms differ</CardTitle>
        <CardDescription>
          {report.kind === "harmonize_many"
            ? "Groups are compared by node. A group whose membership changed has the same node in both arms but different rows."
            : "Links are compared by the pair of rows they join."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!diff ? (
          <p className="text-sm text-neutral-500">
            {report.kind === "harmonize_results"
              ? "There is nothing to compare: a run built from finished jobs has only the names-only arm."
              : "The report has no comparison of the arms (the identifier arm was skipped)."}
          </p>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-3" data-testid="diff-counts">
              {diff.counts.map((c) => (
                <div key={c.key} className="rounded border border-neutral-200 px-3 py-2">
                  <p className="text-xs text-neutral-500">{c.label}</p>
                  <p className="text-lg font-semibold tabular-nums">{c.value.toLocaleString()}</p>
                </div>
              ))}
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              {diff.sets.map((s) => (
                <div key={s.key} data-testid={`diff-set-${s.key}`}>
                  <p className="mb-1 text-sm font-medium text-neutral-900">
                    {s.label} <span className="font-normal text-neutral-500">({s.entries.length})</span>
                  </p>
                  {s.entries.length === 0 ? (
                    <p className="text-xs text-neutral-500">None.</p>
                  ) : (
                    <ul className="max-h-40 space-y-0.5 rounded border border-neutral-100 bg-neutral-50 px-3 py-2 text-xs scroll-visible">
                      {s.entries.map((e, i) => (
                        <li key={i} className="font-mono">{e}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RunFacts({ report, run }: { report: Report; run: HarmonizeRunStatus }) {
  const nl = nameLinking(report);
  const warn = warnings(report);
  const excluded = excludedRows(report);
  const pins = versionPins(report, { kgBuild: run.kgBuild, kgVerified: run.kgVerified });
  return (
    <Card data-testid="run-report-facts">
      <CardHeader>
        <CardTitle>About this run</CardTitle>
        <CardDescription>Name linking, warnings, excluded rows and the versions the run used.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 md:grid-cols-2">
        <section data-testid="name-linking">
          <h3 className="mb-2 text-sm font-semibold">Name linking</h3>
          {nl ? (
            <div className="space-y-1 text-sm">
              <p>
                <Badge variant={nl.enabled ? "success" : "neutral"}>{nl.enabled ? "On" : nl.enabled === false ? "Off" : "Not stated"}</Badge>
                {nl.decidedBy && (
                  <span className="ml-2 text-xs text-neutral-500">
                    Decided by {nl.decidedBy === "user" ? "you, when the run was started" : `the ${nl.decidedBy}`}
                  </span>
                )}
              </p>
              <p className="text-neutral-700">{nl.reason || "The report gives no reason."}</p>
            </div>
          ) : (
            <p className="text-sm text-neutral-500">The report does not say whether name linking was on.</p>
          )}
        </section>

        <section data-testid="warnings">
          <h3 className="mb-2 text-sm font-semibold">Warnings</h3>
          {warn === null ? (
            <p className="text-sm text-neutral-500">This kind of run does not record warnings.</p>
          ) : warn.length === 0 ? (
            <p className="text-sm text-neutral-700">No warnings.</p>
          ) : (
            <ul className="space-y-2">
              {warn.map((w, i) => (
                <li key={i}><Notice tone="warning">{w}</Notice></li>
              ))}
            </ul>
          )}
        </section>

        <section data-testid="excluded">
          <h3 className="mb-2 text-sm font-semibold">Excluded rows</h3>
          {!excluded.reported ? (
            <p className="text-sm text-neutral-500">
              This kind of run does not record excluded rows: the finished jobs already left out blank names.
            </p>
          ) : excluded.total === 0 ? (
            <p className="text-sm text-neutral-700">No rows were excluded from any cohort.</p>
          ) : (
            <div className="max-h-48 space-y-2 scroll-visible">
              {excluded.cohorts.map((c) => (
                <div key={c.label}>
                  <p className="font-mono text-xs text-neutral-900">{c.label}</p>
                  {c.rows.length === 0 ? (
                    <p className="text-xs text-neutral-500">None excluded.</p>
                  ) : (
                    <ul className="text-xs text-neutral-700">
                      {c.rows.map((r, i) => (
                        <li key={i}>Row {r.row}: {r.reason || "no reason given"}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        <section data-testid="version-pins">
          <h3 className="mb-2 text-sm font-semibold">Versions</h3>
          {pins.length === 0 ? (
            <p className="text-sm text-neutral-500">This kind of run records no version pins.</p>
          ) : (
            <FactList rows={pins.map((p) => ({ label: p.label, value: <span className="font-mono text-xs">{p.value}</span> }))} />
          )}
        </section>
      </CardContent>
    </Card>
  );
}
