import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import {
  getGetHarmonizeReviewItemQueryKey,
  getListHarmonizeReviewItemsQueryKey,
  useGetHarmonizeReviewItem,
  useListHarmonizeReviewItems,
  type HarmonizeRunStatus,
  type HarmonizeSideDetail,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import {
  ARMS,
  armData,
  armLabel,
  asArray,
  asObject,
  cohortCounts,
  errorMessage,
  excludedRows,
  humanize,
  identifierSkippedReason,
  isMany,
  nameLinking,
  pinRows,
  plural,
  reportLabels,
  str,
  unresolvedRows,
  warnings,
  type Arm,
  type Json,
} from "@/lib/harmonize";
import { DataTable, EmptyState, ErrorPanel, LoadingBlock, Mono, Note, Panel, Stat, Untrusted } from "./common";

const fmt = (v: unknown) => (typeof v === "number" ? v.toLocaleString() : v == null ? "Not reported" : String(v));
const yesNo = (v: unknown) => (v === true ? "Yes" : v === false ? "No" : "Not reported");

// ---------------------------------------------------------------------------
// Summary: the two arms side by side, their difference, and the run's notes
// ---------------------------------------------------------------------------

/** Why there is no identifier arm on this run. */
function identifierAbsence(report: Json, kind: string): string {
  const reason = identifierSkippedReason(report);
  if (reason) return reason;
  if (kind === "harmonize_results")
    return "A run from two finished mapping jobs harmonizes the mapped results as they are, so it has only the names-only arm.";
  return "The report gives no reason.";
}

function ArmCard({ report, arm, kind }: { report: Json; arm: Arm; kind: string }) {
  const data = armData(report, arm);
  const many = isMany(kind);
  if (!data) {
    return (
      <section aria-label={armLabel(arm)} className="rounded border border-dashed border-neutral-300 bg-neutral-50 p-4" data-testid={`arm-${arm}`}>
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-neutral-900">{armLabel(arm)}</h3>
          <Badge variant="neutral">Skipped</Badge>
        </div>
        <p className="mt-2 text-sm text-neutral-700" data-testid="identifier-skipped-reason">{identifierAbsence(report, kind)}</p>
      </section>
    );
  }
  const s = asObject(data.summary) ?? {};
  const counts = cohortCounts(report, arm);
  const stats: [string, unknown][] = many
    ? [
        ["Groups", s.groups],
        ["Multi-cohort groups", s.multi_cohort_groups],
        ["Clean groups", s.clean_groups],
        ["With multiplicity", s.multiplicity_groups],
        ["Broad groups", s.broad_groups],
        ["Cross-node entries", s.cross_node_entries],
        ["ID checks to review", asObject(s.id_check)?.n_review],
        ["Withheld name pairs", s.withheld_name_pairs],
      ]
    : [
        ["Links", s.n_links],
        ["One-to-one", s.n_one_to_one_links],
        ["Ambiguous", s.n_ambiguous_links],
        ["Name-only links", s.n_name_only_links],
        ["Withheld name matches", s.n_name_match_withheld],
        ["Possible misses", s.n_possible_missed],
      ];
  const byBasis = asObject(s.links_by_basis);
  return (
    <section aria-label={armLabel(arm)} className="rounded border border-neutral-200 bg-white p-4" data-testid={`arm-${arm}`}>
      <h3 className="text-sm font-semibold text-neutral-900">{armLabel(arm)}</h3>
      <p className="text-xs text-neutral-500">
        {arm === "names_only" ? "Rows mapped by name only." : "Rows mapped with their declared identifiers as hints."}
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded bg-neutral-50 px-3 py-2">
            <dt className="text-xs text-neutral-500">{label}</dt>
            <dd className="text-base font-semibold tabular-nums text-neutral-900">{fmt(value)}</dd>
          </div>
        ))}
      </dl>
      {byBasis && (
        <p className="mt-2 text-xs text-neutral-600">
          Links by basis: {Object.entries(byBasis).map(([k, v]) => `${k} ${fmt(v)}`).join(", ")}
        </p>
      )}
      <div className="mt-3">
        <DataTable
          caption={`${armLabel(arm)} per cohort`}
          maxHeight="max-h-60"
          headers={many ? ["Cohort", "Rows", "Grouped", "Unresolved", "No node", "Errored"] : ["Cohort", "Rows", "Linked", "Unresolved", "Errored"]}
          rows={counts.map((c) =>
            many
              ? [c.label, fmt(c.total), fmt(c.grouped), fmt(c.unresolved), fmt(c.noNode), fmt(c.errors)]
              : [c.label, fmt(c.total), fmt(c.linked), fmt(c.unresolved), fmt(c.errors)],
          )}
          empty="No per-cohort counts in this report."
        />
      </div>
    </section>
  );
}

function DiffList({ title, entries, many }: { title: string; entries: unknown[]; many: boolean }) {
  return (
    <details className="rounded border border-neutral-200 bg-white">
      <summary className="cursor-pointer px-4 py-2 text-sm font-medium text-neutral-900">
        {title} <span className="tabular-nums text-neutral-500">({entries.length.toLocaleString()})</span>
      </summary>
      <div className="px-4 pb-3">
        {entries.length === 0 ? (
          <p className="text-sm text-neutral-500">None.</p>
        ) : many ? (
          <div className="scroll-visible max-h-48 rounded border border-neutral-100 p-2">
            <ul className="flex flex-wrap gap-1.5">
              {entries.map((e, i) => (
                <li key={i}>
                  <Mono className="rounded bg-neutral-100 px-1.5 py-0.5">{String(e)}</Mono>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <DataTable
            caption={title}
            maxHeight="max-h-48"
            headers={["A key", "B key"]}
            rows={entries.map((e) => {
              const o = asObject(e) ?? {};
              return [<Mono key="a">{String(o.a_key ?? "")}</Mono>, <Mono key="b">{String(o.b_key ?? "")}</Mono>];
            })}
            empty="None."
          />
        )}
      </div>
    </details>
  );
}

export function SummaryView({ report, run }: { report: Json; run: HarmonizeRunStatus }) {
  const kind = String(report.kind ?? run.kind);
  const many = isMany(kind);
  const nl = nameLinking(report);
  const diff = asObject(report.diff);
  const diffCounts = asObject(diff?.counts);
  const warns = warnings(report);
  const excluded = excludedRows(report);
  const totalExcluded = excluded.reduce((n, e) => n + e.rows.length, 0);

  return (
    <div className="space-y-6">
      {many && (
        <div className="grid gap-3 sm:grid-cols-2" data-testid="many-status">
          <Stat label="Run status" value={humanize(String(report.status ?? "Not reported"))} hint="ok, partial or failed, as the package reports it" />
          <Stat
            label="Grade"
            value={<span className="text-base">{String(report.grade ?? report.publication_grade ?? "Not reported")}</span>}
            hint="Whether the result is fit for publication"
          />
        </div>
      )}

      <Panel id="name-linking" title="Name linking" headingLevel={2}>
        {nl ? (
          <div className="space-y-2" data-testid="name-linking">
            <p className="text-sm">
              <Badge variant={nl.enabled ? "success" : "neutral"}>{nl.enabled ? "On" : "Off"}</Badge>
              {nl.decidedBy && <span className="ml-2 text-xs text-neutral-500">Decided by: {nl.decidedBy === "user" ? "you, when you started the run" : nl.decidedBy}</span>}
            </p>
            <p className="text-sm text-neutral-700">{nl.reason || "The report gives no reason."}</p>
            {kind !== "harmonize_results" && (
              <p className="text-xs text-neutral-500">Read only: on cohort runs the category decides this.</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-neutral-500">This report does not say whether name linking was on.</p>
        )}
      </Panel>

      <Panel id="arms" title="The two arms side by side" description={many ? "Groups of rows that share a knowledge graph node, per arm." : "Links between the two cohorts, per arm."}>
        <div className="grid gap-4 lg:grid-cols-2">
          {ARMS.map((arm) => (
            <ArmCard key={arm} report={report} arm={arm} kind={kind} />
          ))}
        </div>
      </Panel>

      <Panel id="diff" title="How the arms differ" description={many ? "Group nodes found by one arm, the other, or both." : "Links found by one arm, the other, or both."}>
        {diff ? (
          <div className="space-y-3" data-testid="arm-diff">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Names-only arm only" value={fmt(diffCounts?.names_only_only)} />
              <Stat label="Identifier arm only" value={fmt(diffCounts?.identifier_only)} />
              <Stat label="Both arms" value={fmt(diffCounts?.both)} />
              {many && <Stat label="Membership changed" value={fmt(diffCounts?.membership_changed)} />}
            </div>
            <DiffList title="Found only by the names-only arm" entries={asArray(diff.names_only_only)} many={many} />
            <DiffList title="Found only by the identifier arm" entries={asArray(diff.identifier_only)} many={many} />
            <DiffList title="Found by both arms" entries={asArray(diff.both)} many={many} />
            {many && <DiffList title="Groups whose membership changed" entries={asArray(diff.membership_changed)} many />}
          </div>
        ) : (
          <p className="text-sm text-neutral-500">
            {identifierSkippedReason(report) || kind === "harmonize_results"
              ? "There is no difference to show: only one arm ran."
              : "This report has no arm difference."}
          </p>
        )}
      </Panel>

      <div className="grid gap-6 xl:grid-cols-2">
        <Panel id="warnings" title="Warnings">
          {warns.length === 0 ? (
            <p className="text-sm text-neutral-500">No warnings.</p>
          ) : (
            <ul className="space-y-2" data-testid="warnings">
              {warns.map((w, i) => (
                <li key={i} className="rounded border border-warning-border bg-warning-bg px-3 py-2 text-sm text-neutral-800">
                  {w}
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel id="excluded" title="Excluded rows" description="Rows left out of a cohort, for example blank names.">
          {excluded.length === 0 ? (
            <p className="text-sm text-neutral-500">This report lists no excluded rows.</p>
          ) : totalExcluded === 0 ? (
            <p className="text-sm text-neutral-700" data-testid="excluded-none">
              None excluded: every row of {excluded.map((e) => e.cohort).join(", ")} was kept.
            </p>
          ) : (
            <DataTable
              caption="Excluded rows"
              headers={["Cohort", "Row", "Reason"]}
              rows={excluded.flatMap((e) =>
                e.rows.length === 0
                  ? [[e.cohort, "None excluded", ""]]
                  : e.rows.map((r) => [e.cohort, fmt(r.row ?? r.key), String(r.reason ?? "Not given")]),
              )}
              empty="None excluded."
            />
          )}
        </Panel>
      </div>

      <Panel id="pins" title="Version pins" description="What produced these results.">
        <dl className="grid gap-x-6 gap-y-2 text-sm md:grid-cols-2" data-testid="pins">
          {pinRows(report, run).map((p) => (
            <div key={p.label} className="min-w-0">
              <dt className="text-xs text-neutral-500">{p.label}</dt>
              <dd className="text-neutral-900 [overflow-wrap:anywhere]">{p.value}</dd>
            </div>
          ))}
        </dl>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Results by arm: every list of the report, readable
// ---------------------------------------------------------------------------

function Section({ title, count, children, description }: { title: string; count: number; children: ReactNode; description?: string }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-neutral-900">
        {title} <span className="font-normal tabular-nums text-neutral-500">({count.toLocaleString()})</span>
      </h3>
      {description && <p className="text-xs text-neutral-500">{description}</p>}
      {children}
    </section>
  );
}

function memberLines(members: Json[]): ReactNode {
  return (
    <div className="space-y-0.5">
      {members.map((m, i) => (
        <div key={i}>
          <span className="text-neutral-500">{String(m.cohort ?? "")}</span> <Mono>{String(m.key ?? "")}</Mono>{" "}
          <Untrusted value={str(m.name)} />
        </div>
      ))}
    </div>
  );
}

function TwoCohortArm({ data, report, arm }: { data: Json; report: Json; arm: Arm }) {
  const labels = reportLabels(report);
  const [la, lb] = [labels[0] ?? "A", labels[1] ?? "B"];
  const links = asArray(data.links);
  const withheld = asArray(data.name_match_withheld);
  const missed = asArray(data.possible_missed);
  const unresolved = unresolvedRows(report, arm);
  return (
    <div className="space-y-6">
      <Section title="Links" count={links.length} description="One-to-one links pair one row with one row; ambiguous links share a row with another link.">
        <DataTable
          caption="Links"
          testId="links-table"
          maxHeight="max-h-96"
          headers={[`${la} key`, `${la} name`, `${lb} key`, `${lb} name`, "Type", "Basis", `${la} partners`, `${lb} partners`, "Node"]}
          rows={links.map((l) => [
            <Mono key="ak">{String(l.a_key ?? "")}</Mono>,
            <Untrusted key="an" value={str(l.a_name) ?? str(l.a_key)} />,
            <Mono key="bk">{String(l.b_key ?? "")}</Mono>,
            <Untrusted key="bn" value={str(l.b_name) ?? str(l.b_key)} />,
            l.ambiguous === true ? <Badge key="t" variant="warning">Ambiguous</Badge> : l.one_to_one === true ? <Badge key="t" variant="success">One-to-one</Badge> : "Other",
            String(l.basis ?? "Not reported"),
            fmt(l.a_partners),
            fmt(l.b_partners),
            <Mono key="n">{String(l.a_chosen_kg_id ?? "")}{l.b_chosen_kg_id && l.b_chosen_kg_id !== l.a_chosen_kg_id ? ` / ${l.b_chosen_kg_id}` : ""}</Mono>,
          ])}
          empty="No links in this arm."
        />
      </Section>
      <Section title="Withheld name matches" count={withheld.length} description="Pairs equal by name only, held back and not linked.">
        <DataTable
          caption="Withheld name matches"
          headers={[`${la} key`, `${la} name`, `${lb} key`, `${lb} name`]}
          rows={withheld.map((w) => [<Mono key="a">{String(w.a_key ?? "")}</Mono>, <Untrusted key="an" value={str(w.a_name)} />, <Mono key="b">{String(w.b_key ?? "")}</Mono>, <Untrusted key="bn" value={str(w.b_name)} />])}
          empty="No withheld name matches in this arm."
        />
      </Section>
      <Section title="Possible misses" count={missed.length} description="Rows biomapper thinks may be the same entity as a row in the other cohort, but did not link.">
        <DataTable
          caption="Possible misses"
          headers={["Cohort", "Key", "Name", "Node", "Detail"]}
          rows={missed.map((m) => [
            String(m.cohort ?? ""),
            <Mono key="k">{String(m.key ?? "")}</Mono>,
            <Untrusted key="n" value={str(m.name)} />,
            <Mono key="c">{String(m.chosen_kg_id ?? "")}</Mono>,
            Object.entries(m)
              .filter(([k]) => !["cohort", "key", "name", "chosen_kg_id"].includes(k))
              .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
              .join("; "),
          ])}
          empty="No possible misses in this arm."
        />
      </Section>
      <UnresolvedSection rows={unresolved} />
    </div>
  );
}

function UnresolvedSection({ rows }: { rows: ReturnType<typeof unresolvedRows> }) {
  return (
    <Section title="Unresolved and errored rows" count={rows.length} description="Rows that resolved to nothing, or errored while mapping, per cohort.">
      <DataTable
        caption="Unresolved and errored rows"
        testId="unresolved-table"
        headers={["Cohort", "Key", "Name", "Why", "Error"]}
        rows={rows.map((r) => [
          r.cohort,
          <Mono key="k">{r.key}</Mono>,
          <Untrusted key="n" value={r.name} empty="Not in this report" />,
          humanize(r.bucket),
          r.error ?? "",
        ])}
        empty="Every row resolved in this arm."
      />
    </Section>
  );
}

function ManyCohortArm({ data, report, arm }: { data: Json; report: Json; arm: Arm }) {
  const groups = asArray(data.groups);
  const crossNode = asArray(data.cross_node);
  const idCheck = asArray(data.id_check_review);
  const withheld = asArray(data.withheld);
  const unresolved = unresolvedRows(report, arm);
  const names = new Map(asArray(data.rows).map((r) => [`${r.cohort}\u0000${r.key}`, str(r.name)]));
  return (
    <div className="space-y-6">
      <Section title="Groups" count={groups.length} description="Rows across cohorts that resolved to the same node. Multiplicity: more than one row from one cohort.">
        <DataTable
          caption="Groups"
          testId="groups-table"
          maxHeight="max-h-[28rem]"
          headers={["Node", "Cohorts", "Members", "Clean", "Multiplicity", "Broad"]}
          rows={groups.map((g) => [
            <Mono key="n">{String(g.node ?? "")}</Mono>,
            asArray<string>(g.cohorts).join(", "),
            memberLines(asArray(g.members)),
            yesNo(g.clean),
            g.multiplicity === true ? <Badge key="m" variant="warning">Yes</Badge> : yesNo(g.multiplicity),
            yesNo(g.broad),
          ])}
          empty="No groups in this arm."
        />
      </Section>
      <Section title="Cross-node review entries" count={crossNode.length} description="Rows linked across two different nodes.">
        <DataTable
          caption="Cross-node review entries"
          headers={["Node A", "Node B", "Bases", "Row pairs", "Cohorts"]}
          rows={crossNode.map((c) => [
            <Mono key="a">{String(c.node_a ?? "")}</Mono>,
            <Mono key="b">{String(c.node_b ?? "")}</Mono>,
            asArray<string>(c.bases).join(", "),
            fmt(c.n_row_pairs),
            asArray<string>(c.cohorts).join(", "),
          ])}
          empty="No cross-node entries in this arm."
        />
      </Section>
      <Section title="Identifiers that did not confirm the node" count={idCheck.length} description="Grouped rows whose declared identifiers are not among their node's identifiers. This does not mean they are contradicted.">
        <DataTable
          caption="Identifier check review"
          headers={["Cohort", "Key", "Name", "Node", "Declared", "Status"]}
          rows={idCheck.map((r) => {
            const check = asObject(r.check) ?? {};
            return [
              String(r.cohort ?? ""),
              <Mono key="k">{String(r.key ?? "")}</Mono>,
              <Untrusted key="n" value={str(r.name)} />,
              <Mono key="node">{String(r.node ?? "")}</Mono>,
              <Mono key="d">{asArray<string>(check.declared).join(", ")}</Mono>,
              humanize(String(check.status ?? "Not reported")),
            ];
          })}
          empty="Every grouped row's identifiers confirmed its node, or none were declared."
        />
      </Section>
      <Section title="Withheld name matches" count={withheld.length} description="Pairs equal by name only, held back and not grouped.">
        <DataTable
          caption="Withheld name matches"
          headers={["Cohort", "Key", "Name", "Cohort", "Key", "Name"]}
          rows={withheld.map((w) => [
            String(w.a_cohort ?? ""),
            <Mono key="ak">{String(w.a_key ?? "")}</Mono>,
            <Untrusted key="an" value={names.get(`${w.a_cohort}\u0000${w.a_key}`) ?? null} />,
            String(w.b_cohort ?? ""),
            <Mono key="bk">{String(w.b_key ?? "")}</Mono>,
            <Untrusted key="bn" value={names.get(`${w.b_cohort}\u0000${w.b_key}`) ?? null} />,
          ])}
          empty="No withheld name matches in this arm."
        />
      </Section>
      <UnresolvedSection rows={unresolved} />
    </div>
  );
}

export function ArmResultsView({ report, kind }: { report: Json; kind: string }) {
  const [arm, setArm] = useState<Arm>("names_only");
  const data = armData(report, arm);
  return (
    <div className="space-y-4">
      <div role="radiogroup" aria-label="Arm to show" className="inline-flex rounded border border-neutral-200 bg-neutral-50 p-0.5">
        {ARMS.map((a) => (
          <button
            key={a}
            type="button"
            role="radio"
            aria-checked={arm === a}
            onClick={() => setArm(a)}
            className={cn("rounded px-3 py-1.5 text-sm font-medium", arm === a ? "bg-white text-neutral-900 shadow-xs" : "text-neutral-600 hover:text-neutral-900")}
          >
            {armLabel(a)}
          </button>
        ))}
      </div>
      {!data ? (
        <Note tone="info" title={`The ${armLabel(arm).toLowerCase()} was skipped`}>
          {identifierAbsence(report, kind)}
        </Note>
      ) : isMany(kind) ? (
        <ManyCohortArm data={data} report={report} arm={arm} />
      ) : (
        <TwoCohortArm data={data} report={report} arm={arm} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Review queue: one-sided identifier checks and the package's review items
// ---------------------------------------------------------------------------

const REVIEW_PAGE = 25;

function SideBlock({ title, side }: { title: string; side: HarmonizeSideDetail | undefined }) {
  if (!side) return null;
  const ids = Object.entries(side.identifiers ?? {});
  return (
    <section className="rounded border border-neutral-200 p-3">
      <h4 className="text-sm font-semibold text-neutral-900">{title}</h4>
      <dl className="mt-2 space-y-1.5 text-sm">
        <div>
          <dt className="text-xs text-neutral-500">Node</dt>
          <dd><Mono>{side.node ?? "No node"}</Mono></dd>
        </div>
        <div>
          <dt className="text-xs text-neutral-500">Node name</dt>
          <dd><Untrusted value={side.nodeName} empty={side.nodeNameStatus ? humanize(side.nodeNameStatus) : "Not captured"} /></dd>
        </div>
        <div>
          <dt className="text-xs text-neutral-500">Rows</dt>
          <dd>{memberLines((side.rows ?? []) as unknown as Json[])}</dd>
        </div>
        <div>
          <dt className="text-xs text-neutral-500">Certificate states</dt>
          <dd>{Object.entries(side.certificateStates ?? {}).map(([k, v]) => `${k} ${v}`).join(", ") || "None recorded"}</dd>
        </div>
        <div>
          <dt className="text-xs text-neutral-500">Identifiers</dt>
          <dd>
            {ids.length === 0 ? (
              "None recorded"
            ) : (
              <div className="scroll-visible max-h-40 rounded border border-neutral-100 p-2">
                {ids.map(([vocab, list]) => (
                  <div key={vocab}>
                    <span className="text-xs font-medium text-neutral-700">{vocab}: </span>
                    <Mono>{list.join(", ")}</Mono>
                  </div>
                ))}
              </div>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function ReviewItemDetail({ jobId, refId, onClose }: { jobId: string; refId: string | null; onClose: () => void }) {
  const q = useGetHarmonizeReviewItem(jobId, refId ?? "", {
    query: { queryKey: getGetHarmonizeReviewItemQueryKey(jobId, refId ?? ""), enabled: !!refId },
  });
  const d = q.data;
  return (
    <Sheet open={!!refId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto scroll-visible sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Review item</SheetTitle>
          <SheetDescription>What the engine chose and what to ask an expert.</SheetDescription>
        </SheetHeader>
        <div className="mt-4 space-y-4" data-testid="review-item-detail">
          {q.isLoading ? (
            <LoadingBlock lines={4} label="Loading the review item" />
          ) : q.isError ? (
            <ErrorPanel title="The review item did not load" message={errorMessage(q.error)} onRetry={() => q.refetch()} />
          ) : !d ? null : (
            <>
              <p className="text-sm">
                <Badge variant="neutral">{d.kind === "link" ? "Link" : "Row"}</Badge>
                <span className="ml-2 text-xs text-neutral-500">Impact {d.impact}</span>
              </p>
              {d.row && (
                <dl className="space-y-2 text-sm">
                  <div><dt className="text-xs text-neutral-500">Name</dt><dd><Untrusted value={d.row.name} /></dd></div>
                  <div><dt className="text-xs text-neutral-500">Why it is here</dt><dd>{d.row.weakTrigger ? humanize(d.row.weakTrigger) : "Not given"}</dd></div>
                  <div><dt className="text-xs text-neutral-500">Engine's choice</dt><dd><Mono>{d.row.engineChoice ?? "None: the engine chose no node"}</Mono></dd></div>
                  <div><dt className="text-xs text-neutral-500">Certificate state</dt><dd>{d.row.certificateState ?? "None sent by the engine"}</dd></div>
                  <div>
                    <dt className="text-xs text-neutral-500">Candidates</dt>
                    <dd>
                      {d.row.candidatesStatus ? humanize(d.row.candidatesStatus) : "Not reported"}
                      {d.row.candidatesReason ? `: ${d.row.candidatesReason}` : ""}
                    </dd>
                  </div>
                  <div><dt className="text-xs text-neutral-500">Rows</dt><dd>{memberLines((d.row.rows ?? []) as unknown as Json[])}</dd></div>
                </dl>
              )}
              {d.link && (
                <div className="space-y-3">
                  {d.link.question && (
                    <Note tone="info" title="Question to ask">
                      {d.link.question}
                    </Note>
                  )}
                  <p className="text-sm text-neutral-700">
                    Basis {d.link.basis ?? "not reported"}
                    {d.link.bases?.length ? ` (all bases: ${d.link.bases.join(", ")})` : ""}
                    {d.link.reviewReasons?.length ? `. Flagged because: ${d.link.reviewReasons.map(humanize).join(", ")}` : ""}
                  </p>
                  <div className="grid gap-3">
                    <SideBlock title="Side A" side={d.link.a} />
                    <SideBlock title="Side B" side={d.link.b} />
                  </div>
                </div>
              )}
              {d.note && <p className="text-xs text-neutral-500">{d.note}</p>}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function ReviewQueueView({ report, run }: { report: Json; run: HarmonizeRunStatus }) {
  const [offset, setOffset] = useState(0);
  const [openRef, setOpenRef] = useState<string | null>(null);
  const params = { offset, limit: REVIEW_PAGE };
  const q = useListHarmonizeReviewItems(run.jobId, params, {
    query: { queryKey: getListHarmonizeReviewItemsQueryKey(run.jobId, params) },
  });
  const queue = asArray(report.review_queue);
  const checks = asArray(report.review);
  const isTwo = run.kind === "harmonize_cohorts";

  return (
    <div className="space-y-6">
      {isTwo && (
        <Panel
          id="review-queue"
          title="One-sided identifier checks"
          description="A vocabulary declared for only one cohort is not used for mapping. Its codes are checked against that cohort's name results instead; disagreements are queued for review."
        >
          <div className="space-y-4">
            <Section title="Review queue" count={queue.length}>
              <DataTable
                caption="Review queue"
                testId="review-queue-table"
                headers={["Cohort", "Key", "Name", "Vocabulary", "Code", "Code resolves to", "Name resolves to", "Status"]}
                rows={queue.map((r) => [
                  String(r.cohort ?? ""),
                  <Mono key="k">{String(r.key ?? "")}</Mono>,
                  <Untrusted key="n" value={str(r.name)} />,
                  String(r.vocabulary ?? ""),
                  <Mono key="c">{String(r.code ?? "")}</Mono>,
                  <Mono key="ce">{String(r.code_entry ?? "None")}</Mono>,
                  <Mono key="ne">{String(r.name_entry ?? "None")}</Mono>,
                  humanize(String(r.status ?? "")),
                ])}
                empty="Nothing queued: every one-sided code agreed with its row's name result."
              />
            </Section>
            <Section title="Every one-sided check" count={checks.length}>
              <DataTable
                caption="Every one-sided check"
                headers={["Cohort", "Key", "Name", "Vocabulary", "Code", "Status"]}
                rows={checks.map((r) => [
                  String(r.cohort ?? ""),
                  <Mono key="k">{String(r.key ?? "")}</Mono>,
                  <Untrusted key="n" value={str(r.name)} />,
                  String(r.vocabulary ?? ""),
                  <Mono key="c">{String(r.code ?? "")}</Mono>,
                  humanize(String(r.status ?? "")),
                ])}
                empty="No vocabulary was declared for only one cohort, so there were no one-sided checks."
              />
            </Section>
          </div>
        </Panel>
      )}

      <Panel
        id="review-items"
        title="Review items"
        description="Rows and links biomapper wants a person to look at. Open one to see the engine's choice and evidence."
      >
        {q.isLoading ? (
          <LoadingBlock label="Loading review items" />
        ) : q.isError ? (
          <ErrorPanel title="Review items did not load" message={errorMessage(q.error)} onRetry={() => q.refetch()} />
        ) : !q.data || q.data.total === 0 ? (
          <EmptyState
            compact
            title="No review items"
            description={
              run.kind === "harmonize_results"
                ? "This run harmonized two finished mapping jobs, so no review evidence was captured."
                : "biomapper found nothing that needs a closer look."
            }
          />
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-neutral-600">
              {plural(q.data.total, "review item")}
              {Object.keys(q.data.counts ?? {}).length > 0 &&
                ` (${Object.entries(q.data.counts).map(([k, v]) => `${v} ${k}${v === 1 ? "" : "s"}`).join(", ")})`}
              {q.data.skippedNoNode > 0 && `. ${q.data.skippedNoNode} without a node were skipped.`}
            </p>
            <div className="scroll-visible max-h-96 rounded border border-neutral-200">
              <table className="w-full text-sm">
                <caption className="sr-only">Review items</caption>
                <thead className="sticky top-0 z-10 bg-neutral-50">
                  <tr className="border-b border-neutral-200">
                    {["Kind", "Label", "Why", "Cohorts", "Rows", ""].map((h, i) => (
                      <th key={i} scope="col" className="whitespace-nowrap px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-neutral-500">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {q.data.items.map((it) => (
                    <tr key={it.ref} className="border-b border-neutral-100 hover:bg-neutral-50">
                      <td className="px-3 py-2">{it.kind === "link" ? "Link" : "Row"}</td>
                      <td className="max-w-xs truncate px-3 py-2" title={it.label}><Untrusted value={it.label} /></td>
                      <td className="px-3 py-2">{it.reasons.map(humanize).join(", ") || "Not given"}</td>
                      <td className="px-3 py-2">{it.cohorts.join(", ")}</td>
                      <td className="px-3 py-2 tabular-nums">{it.nRows}</td>
                      <td className="px-3 py-2 text-right">
                        <Button size="sm" variant="secondary" onClick={() => setOpenRef(it.ref)} aria-label={`Open review item ${it.label}`}>
                          Open <ChevronRight aria-hidden />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager offset={offset} pageSize={REVIEW_PAGE} total={q.data.total} onOffset={setOffset} noun="review items" />
          </div>
        )}
      </Panel>
      <ReviewItemDetail jobId={run.jobId} refId={openRef} onClose={() => setOpenRef(null)} />
    </div>
  );
}

export function Pager({
  offset,
  pageSize,
  total,
  onOffset,
  noun,
}: {
  offset: number;
  pageSize: number;
  total: number;
  onOffset: (n: number) => void;
  noun: string;
}) {
  if (total === 0) return null;
  const from = offset + 1;
  const to = Math.min(offset + pageSize, total);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-neutral-600">
      <p className="tabular-nums" aria-live="polite">
        Showing {from.toLocaleString()} to {to.toLocaleString()} of {total.toLocaleString()} {noun}
      </p>
      {total > pageSize && (
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - pageSize))}>
            Previous page
          </Button>
          <Button size="sm" variant="secondary" disabled={to >= total} onClick={() => onOffset(offset + pageSize)}>
            Next page
          </Button>
        </div>
      )}
    </div>
  );
}

