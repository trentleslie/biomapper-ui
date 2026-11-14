import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FileUp, Loader2, Trash2 } from "lucide-react";
import {
  getListEntityTypesQueryKey,
  getListHarmonizeRunsQueryKey,
  getListJobsQueryKey,
  getListVocabulariesQueryKey,
  getGetJobQueryKey,
  inspectHarmonizeFile,
  submitHarmonizeCohorts,
  submitHarmonizeExample,
  submitHarmonizeFromJobs,
  submitHarmonizeMany,
  useGetJob,
  useListEntityTypes,
  useListJobs,
  useListVocabularies,
  type HarmonizeRunStatus,
  type JobListItem,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  COMMON_ENTITY_TYPES,
  MAX_COHORT_BYTES,
  MAX_COHORTS,
  apiErrorMessage,
  cleanVocabularies,
  guessKeyColumn,
  guessNameColumn,
  guessVocabularies,
  labelFromFilename,
  oversizeMessage,
} from "@/lib/harmonize";
import { ErrorBox, NativeSelect } from "./primitives";

export type SetupTab = "files" | "jobs" | "examples";

const COMMON_VOCABULARIES = ["HMDB", "KEGG", "CHEBI", "PUBCHEM.COMPOUND", "LIPIDMAPS", "REFMET", "INCHIKEY", "CAS", "UNIPROTKB", "NCBIGENE", "HGNC", "LOINC"];
const OTHER = "__other__";

interface CohortDraft {
  id: number;
  file: File;
  inspect: { state: "loading" } | { state: "ok"; columns: string[]; rowCount: number } | { state: "error"; message: string };
  label: string;
  nameColumn: string;
  keyColumn: string;
  /** Column name -> vocabulary it holds ("" = not an identifier column). */
  columnVocab: Record<string, string>;
  /** Columns whose vocabulary is being typed by hand. */
  otherColumns: Record<string, boolean>;
}

let nextId = 1;

function vocabulariesOf(draft: CohortDraft): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [column, vocab] of Object.entries(draft.columnVocab)) {
    if (!vocab.trim() || column === draft.nameColumn) continue;
    (out[vocab.trim()] ??= []).push(column);
  }
  return cleanVocabularies(out);
}

function cohortSpec(draft: CohortDraft) {
  return {
    label: draft.label,
    nameColumn: draft.nameColumn,
    keyColumn: draft.keyColumn || null,
    vocabularies: vocabulariesOf(draft),
  };
}

function useKnownVocabularies(): string[] {
  const q = useListVocabularies({ query: { queryKey: getListVocabulariesQueryKey(), staleTime: 10 * 60_000, retry: 1 } });
  return useMemo(() => {
    const fromApi = (q.data ?? []).map((v) => v.prefix).filter(Boolean);
    return [...new Set([...COMMON_VOCABULARIES, ...fromApi])];
  }, [q.data]);
}

// ---------------------------------------------------------------------------
// One cohort file: header, row count, label and column choices
// ---------------------------------------------------------------------------

function CohortCard({
  draft,
  title,
  known,
  onChange,
  onRemove,
}: {
  draft: CohortDraft;
  title: string;
  known: string[];
  onChange: (next: CohortDraft) => void;
  onRemove: () => void;
}) {
  const insp = draft.inspect;
  const idp = `cohort-${draft.id}`;
  return (
    <fieldset className="rounded border border-neutral-200 bg-white p-3" data-testid="cohort-card">
      <legend className="sr-only">{title}</legend>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-neutral-500">{title}</p>
          <p className="truncate text-sm font-medium text-neutral-900" title={draft.file.name}>
            {draft.file.name}
          </p>
          {insp.state === "ok" && (
            <p className="text-xs text-neutral-600" data-testid="cohort-inspect">
              {insp.rowCount.toLocaleString()} rows · {insp.columns.length} columns: {insp.columns.join(", ")}
            </p>
          )}
          {insp.state === "loading" && (
            <p className="flex items-center gap-1 text-xs text-neutral-500">
              <Loader2 aria-hidden className="h-3 w-3 animate-spin" /> Reading the header
            </p>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onRemove} aria-label={`Remove ${draft.file.name}`}>
          <Trash2 aria-hidden />
        </Button>
      </div>
      {insp.state === "error" && <ErrorBox className="mt-2" title="This file cannot be used" message={insp.message} />}
      {insp.state === "ok" && (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1 text-xs font-medium text-neutral-600">
            <label htmlFor={`${idp}-label`}>Cohort label</label>
            <Input
              id={`${idp}-label`}
              className="h-8"
              value={draft.label}
              onChange={(e) => onChange({ ...draft, label: e.target.value })}
            />
          </div>
          <NativeSelect
            id={`${idp}-name`}
            label="Name column"
            value={draft.nameColumn}
            onChange={(e) => onChange({ ...draft, nameColumn: e.target.value })}
          >
            {insp.columns.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect
            id={`${idp}-key`}
            label="Key column (optional)"
            value={draft.keyColumn}
            onChange={(e) => onChange({ ...draft, keyColumn: e.target.value })}
          >
            <option value="">None (use row numbers)</option>
            {insp.columns.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </NativeSelect>
          <div className="sm:col-span-3">
            <p className="text-xs font-medium text-neutral-600">Identifier columns</p>
            <p className="mb-1 text-xs text-neutral-500">
              For each column that holds identifiers, choose its vocabulary. Several columns can hold the same vocabulary.
            </p>
            <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
              {insp.columns
                .filter((c) => c !== draft.nameColumn)
                .map((column) => {
                  const vocab = draft.columnVocab[column] ?? "";
                  const other = draft.otherColumns[column] || (vocab !== "" && !known.includes(vocab));
                  return (
                    <div key={column} className="flex items-center gap-2">
                      <label htmlFor={`${idp}-v-${column}`} className="w-28 shrink-0 truncate font-mono text-xs text-neutral-800" title={column}>
                        {column}
                      </label>
                      <select
                        id={`${idp}-v-${column}`}
                        aria-label={`Vocabulary in column ${column} of ${draft.label || draft.file.name}`}
                        className="h-7 min-w-0 flex-1 rounded border border-neutral-300 bg-white px-1 text-xs"
                        value={other ? OTHER : vocab}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === OTHER) {
                            onChange({ ...draft, otherColumns: { ...draft.otherColumns, [column]: true }, columnVocab: { ...draft.columnVocab, [column]: "" } });
                          } else {
                            onChange({ ...draft, otherColumns: { ...draft.otherColumns, [column]: false }, columnVocab: { ...draft.columnVocab, [column]: v } });
                          }
                        }}
                      >
                        <option value="">Not an identifier column</option>
                        {known.map((k) => (
                          <option key={k} value={k}>
                            {k}
                          </option>
                        ))}
                        <option value={OTHER}>Other vocabulary...</option>
                      </select>
                      {other && (
                        <Input
                          aria-label={`Vocabulary name for column ${column}`}
                          placeholder="Vocabulary"
                          className="h-7 w-28 text-xs"
                          value={vocab}
                          onChange={(e) => onChange({ ...draft, columnVocab: { ...draft.columnVocab, [column]: e.target.value } })}
                        />
                      )}
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      )}
    </fieldset>
  );
}

function useCohortDrafts(known: string[]) {
  const [drafts, setDrafts] = useState<CohortDraft[]>([]);
  const knownRef = useRef(known);
  knownRef.current = known;

  function add(files: File[]) {
    const fresh: CohortDraft[] = files.map((file) => ({
      id: nextId++,
      file,
      inspect: file.size > MAX_COHORT_BYTES ? { state: "error", message: oversizeMessage(file.name) } : { state: "loading" },
      label: labelFromFilename(file.name),
      nameColumn: "",
      keyColumn: "",
      columnVocab: {},
      otherColumns: {},
    }));
    setDrafts((d) => [...d, ...fresh]);
    for (const draft of fresh) {
      if (draft.inspect.state !== "loading") continue;
      inspectHarmonizeFile({ file: draft.file })
        .then((res) => {
          const vocabs = guessVocabularies(res.columns, knownRef.current);
          const columnVocab: Record<string, string> = {};
          for (const [vocab, cols] of Object.entries(vocabs)) for (const c of cols) columnVocab[c] = vocab;
          const nameColumn = guessNameColumn(res.columns);
          delete columnVocab[nameColumn];
          setDrafts((all) =>
            all.map((x) =>
              x.id === draft.id
                ? { ...x, inspect: { state: "ok", columns: res.columns, rowCount: res.rowCount }, nameColumn, keyColumn: guessKeyColumn(res.columns) ?? "", columnVocab }
                : x,
            ),
          );
        })
        .catch((e) => {
          setDrafts((all) => all.map((x) => (x.id === draft.id ? { ...x, inspect: { state: "error", message: apiErrorMessage(e) } } : x)));
        });
    }
  }

  return {
    drafts,
    add,
    update: (next: CohortDraft) => setDrafts((all) => all.map((x) => (x.id === next.id ? next : x))),
    remove: (id: number) => setDrafts((all) => all.filter((x) => x.id !== id)),
    reset: () => setDrafts([]),
  };
}

function FilePickButton({ label, multiple, onFiles, testId }: { label: string; multiple: boolean; onFiles: (f: File[]) => void; testId: string }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        data-testid={testId}
        type="file"
        accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
        multiple={multiple}
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) onFiles(files);
          e.target.value = "";
        }}
      />
      <Button type="button" variant="secondary" onClick={() => ref.current?.click()}>
        <FileUp aria-hidden /> {label}
      </Button>
    </>
  );
}

// ---------------------------------------------------------------------------
// Entity type and category, shared by both upload modes
// ---------------------------------------------------------------------------

function EntityFields({ entity, setEntity, category, setCategory }: { entity: string; setEntity: (v: string) => void; category: string; setCategory: (v: string) => void }) {
  const q = useListEntityTypes({ query: { queryKey: getListEntityTypesQueryKey(), staleTime: 10 * 60_000, retry: 1 } });
  const rest = useMemo(() => {
    const common = new Set(COMMON_ENTITY_TYPES.map((c) => c.type));
    return (q.data ?? []).map((t) => t.type).filter((t) => t && !common.has(t)).sort();
  }, [q.data]);
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div>
        <NativeSelect id="harm-entity" label="Entity type" value={entity} onChange={(e) => setEntity(e.target.value)}>
          <optgroup label="Common">
            {COMMON_ENTITY_TYPES.map((c) => (
              <option key={c.type} value={c.type}>
                {c.label} ({c.type})
              </option>
            ))}
          </optgroup>
          {rest.length > 0 && (
            <optgroup label="All entity types">
              {rest.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </optgroup>
          )}
        </NativeSelect>
        {q.isLoading && <p className="mt-1 text-xs text-neutral-500">Loading the full list of entity types</p>}
        {q.isError && <p className="mt-1 text-xs text-neutral-600">The full list could not be loaded ({apiErrorMessage(q.error)}); the common types are offered.</p>}
      </div>
      <div className="flex flex-col gap-1 text-xs font-medium text-neutral-600">
        <label htmlFor="harm-category">Category override (optional)</label>
        <Input id="harm-category" aria-describedby="harm-category-hint" className="h-8" placeholder="Leave blank to use the entity type" value={category} onChange={(e) => setCategory(e.target.value)} />
        <span id="harm-category-hint" className="font-normal text-neutral-500">A Biolink category, for example biolink:ClinicalMeasurement. Sent as written.</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upload tab
// ---------------------------------------------------------------------------

function UploadTab({ onStarted }: { onStarted: (run: HarmonizeRunStatus) => void }) {
  const known = useKnownVocabularies();
  const { drafts, add, update, remove } = useCohortDrafts(known);
  const [mode, setMode] = useState<"two" | "many">("two");
  const [entity, setEntity] = useState("biolink:SmallMolecule");
  const [category, setCategory] = useState("");
  const [remapAll, setRemapAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = drafts.length > 0 && drafts.every((d) => d.inspect.state === "ok");
  const canStart = mode === "two" ? drafts.length === 2 && ready : ready;

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const base = { entity, category: category.trim() ? category.trim() : null };
      let run: HarmonizeRunStatus;
      if (mode === "two") {
        const [a, b] = drafts;
        run = await submitHarmonizeCohorts({ fileA: a.file, fileB: b.file, spec: JSON.stringify({ ...base, a: cohortSpec(a), b: cohortSpec(b) }) });
      } else {
        run = await submitHarmonizeMany({ files: drafts.map((d) => d.file), spec: JSON.stringify({ ...base, remapAll, cohorts: drafts.map(cohortSpec) }) });
      }
      onStarted(run);
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="mb-1 text-xs font-medium text-neutral-600">How many cohorts</legend>
        <div className="inline-flex rounded border border-neutral-300 p-0.5" role="radiogroup" aria-label="How many cohorts">
          {(
            [
              ["two", "Two cohorts"],
              ["many", `Many cohorts (2 to ${MAX_COHORTS})`],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              onClick={() => setMode(value)}
              className={cn("rounded px-3 py-1 text-sm", mode === value ? "bg-ph-navy text-white" : "text-neutral-700 hover:bg-neutral-100")}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs text-neutral-500">
          {mode === "two"
            ? "Two cohorts are linked row to row: one-to-one and ambiguous links, with a review queue."
            : "Many cohorts are grouped by the node each row resolves to, across every cohort at once."}
        </p>
      </fieldset>

      <EntityFields entity={entity} setEntity={setEntity} category={category} setCategory={setCategory} />

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {mode === "two" ? (
            drafts.length < 2 && (
              <FilePickButton
                testId="harm-file-input"
                label={drafts.length === 0 ? "Choose cohort files" : "Choose the second cohort file"}
                multiple
                onFiles={(files) => add(files.slice(0, 2 - drafts.length))}
              />
            )
          ) : (
            <FilePickButton testId="harm-file-input" label={drafts.length === 0 ? "Choose cohort files" : "Add more cohort files"} multiple onFiles={add} />
          )}
          <span className="text-xs text-neutral-500">
            .csv, .tsv or .txt, up to 50 MB and 20,000 rows each. Panel metadata only: names and identifier columns.
          </span>
        </div>
        {mode === "two" && drafts.length > 2 && (
          <p className="text-xs text-warning">Two-cohort runs use exactly two files. Remove the extra files, or switch to many cohorts.</p>
        )}
        {drafts.map((d, i) => (
          <CohortCard
            key={d.id}
            draft={d}
            title={mode === "two" ? (i === 0 ? "Cohort A" : i === 1 ? "Cohort B" : `Extra file ${i + 1}`) : `Cohort ${i + 1}`}
            known={known}
            onChange={update}
            onRemove={() => remove(d.id)}
          />
        ))}
      </div>

      {mode === "many" && (
        <label className="flex items-start gap-2 text-sm text-neutral-800">
          <input type="checkbox" className="mt-1" checked={remapAll} onChange={(e) => setRemapAll(e.target.checked)} />
          <span>
            Remap all rows
            <span className="block text-xs text-neutral-500">Map every row again instead of reusing saved mappings.</span>
          </span>
        </label>
      )}

      <div className="sticky bottom-0 -mx-6 border-t border-neutral-200 bg-white px-6 py-3">
        {error && <ErrorBox className="mb-2" title="The run did not start" message={error} />}
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-neutral-500">
            {mode === "two"
              ? drafts.length < 2
                ? `Choose ${2 - drafts.length} more ${2 - drafts.length === 1 ? "file" : "files"}.`
                : !ready
                  ? "Waiting for the files to be read."
                  : "Ready to start."
              : drafts.length === 0
                ? "Choose cohort files."
                : !ready
                  ? "Waiting for the files to be read."
                  : `${drafts.length} cohort ${drafts.length === 1 ? "file" : "files"} ready.`}
          </p>
          <Button disabled={!canStart || busy} onClick={() => void start()}>
            {busy && <Loader2 aria-hidden className="animate-spin" />}
            Start harmonizing
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Finished jobs tab
// ---------------------------------------------------------------------------

function jobName(job: JobListItem): string {
  return job.displayName || `Job ${job.jobId.slice(0, 8)}`;
}

function JobEntity({ jobId }: { jobId: string }) {
  const q = useGetJob(jobId, { query: { queryKey: getGetJobQueryKey(jobId), enabled: !!jobId, staleTime: 60_000, retry: 1 } });
  if (!jobId) return null;
  if (q.isLoading) return <span className="text-xs text-neutral-500">Reading the entity type</span>;
  if (q.isError) return <span className="text-xs text-neutral-600">Entity type unavailable: {apiErrorMessage(q.error)}</span>;
  // The API sends the stored config as written (entity_type); the schema names it entityType. Read either.
  const config = (q.data?.config ?? null) as { entityType?: string; entity_type?: string } | null;
  const entity = config?.entityType ?? config?.entity_type;
  return <span className="text-xs text-neutral-600">Entity type: {entity || "not recorded"}</span>;
}

function JobsTab({ onStarted }: { onStarted: (run: HarmonizeRunStatus) => void }) {
  const q = useListJobs({ query: { queryKey: getListJobsQueryKey(), retry: 1 } });
  const [jobA, setJobA] = useState("");
  const [jobB, setJobB] = useState("");
  const [aLabel, setALabel] = useState("");
  const [bLabel, setBLabel] = useState("");
  const [linkByName, setLinkByName] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const jobs = q.data ?? [];
  const byId = new Map(jobs.map((j) => [j.jobId, j]));

  function pick(side: "a" | "b", id: string) {
    const job = byId.get(id);
    const label = job ? labelFromFilename(jobName(job)) : "";
    if (side === "a") {
      setJobA(id);
      if (!aLabel || (jobA && aLabel === labelFromFilename(jobName(byId.get(jobA)!)))) setALabel(label);
    } else {
      setJobB(id);
      if (!bLabel || (jobB && bLabel === labelFromFilename(jobName(byId.get(jobB)!)))) setBLabel(label);
    }
  }

  async function start() {
    setBusy(true);
    setError(null);
    try {
      onStarted(await submitHarmonizeFromJobs({ jobA, jobB, aLabel, bLabel, linkByName }));
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (q.isLoading) return <p className="text-sm text-neutral-500">Loading your mapping jobs</p>;
  if (q.isError) return <ErrorBox title="Could not load your mapping jobs" message={apiErrorMessage(q.error)} onRetry={() => void q.refetch()} />;
  const finished = jobs.filter((j) => j.status === "complete");
  if (jobs.length === 0) {
    return <p className="text-sm text-neutral-600">You have no mapping jobs yet. Map two files on the New job page, then harmonize them here without mapping again.</p>;
  }

  const options = (exclude: string) =>
    jobs.map((j) => (
      <option key={j.jobId} value={j.jobId} disabled={j.status !== "complete" || j.jobId === exclude}>
        {jobName(j)} · {j.total} names{j.status !== "complete" ? ` (${j.status}, not finished)` : ""}
      </option>
    ));

  return (
    <div className="space-y-4">
      <p className="text-sm text-neutral-600">
        Harmonize two of your finished mapping jobs of the same entity type. Nothing is mapped again, so the run is complete as soon as it starts.
        {finished.length < 2 && " You need at least two finished jobs."}
      </p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {(["a", "b"] as const).map((side) => {
          const id = side === "a" ? jobA : jobB;
          return (
            <div key={side} className="space-y-2 rounded border border-neutral-200 p-3">
              <NativeSelect id={`job-${side}`} label={side === "a" ? "Job A" : "Job B"} value={id} onChange={(e) => pick(side, e.target.value)}>
                <option value="">Choose a finished job</option>
                {options(side === "a" ? jobB : jobA)}
              </NativeSelect>
              <JobEntity jobId={id} />
              <div className="flex flex-col gap-1 text-xs font-medium text-neutral-600">
                <label htmlFor={`job-${side}-label`}>{side === "a" ? "Label for job A" : "Label for job B"}</label>
                <Input id={`job-${side}-label`} className="h-8" value={side === "a" ? aLabel : bLabel} onChange={(e) => (side === "a" ? setALabel : setBLabel)(e.target.value)} />
              </div>
            </div>
          );
        })}
      </div>
      <label className="flex items-start gap-2 text-sm text-neutral-800">
        <input type="checkbox" className="mt-1" checked={linkByName} onChange={(e) => setLinkByName(e.target.checked)} />
        <span>
          Also link rows by name
          <span className="block text-xs text-neutral-500">
            Off links by identifier only. On, two resolved rows whose names are equal are linked even when they resolved to different nodes.
          </span>
        </span>
      </label>
      {error && <ErrorBox title="The run did not start" message={error} />}
      <div className="flex justify-end">
        <Button disabled={!jobA || !jobB || !aLabel || !bLabel || busy} onClick={() => void start()}>
          {busy && <Loader2 aria-hidden className="animate-spin" />}
          Harmonize these jobs
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------

export function useStartExample(onStarted: (run: HarmonizeRunStatus) => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function start(kind: "two_cohort" | "many_cohort") {
    setBusy(kind);
    setError(null);
    try {
      onStarted(await submitHarmonizeExample({ kind }));
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  return { start, busy, error };
}

function ExamplesTab({ onStarted }: { onStarted: (run: HarmonizeRunStatus) => void }) {
  const { start, busy, error } = useStartExample(onStarted);
  return (
    <div className="space-y-3">
      <p className="text-sm text-neutral-600">Invented example cohorts built from public metabolite names and identifiers. No files to pick.</p>
      {(
        [
          ["two_cohort", "Two-cohort example", "Two cohorts of 30 rows: plain links, synonyms, an ambiguous link, a one-sided identifier check and unresolved rows."],
          ["many_cohort", "Many-cohort example", "Five cohorts of 16 rows: groups across cohorts, a group with multiplicity, a cross-node review entry and rows not grouped."],
        ] as const
      ).map(([kind, title, text]) => (
        <div key={kind} className="flex items-center justify-between gap-3 rounded border border-neutral-200 p-3">
          <div>
            <p className="text-sm font-semibold text-neutral-900">{title}</p>
            <p className="text-xs text-neutral-600">{text}</p>
          </div>
          <Button disabled={busy !== null} onClick={() => void start(kind)}>
            {busy === kind && <Loader2 aria-hidden className="animate-spin" />}
            Run the {kind === "two_cohort" ? "two-cohort" : "many-cohort"} example
          </Button>
        </div>
      ))}
      {error && <ErrorBox title="The example did not start" message={error} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

export function SetupSheet({
  open,
  onOpenChange,
  tab,
  onTabChange,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tab: SetupTab;
  onTabChange: (tab: SetupTab) => void;
  onStarted: (run: HarmonizeRunStatus) => void;
}) {
  const queryClient = useQueryClient();
  const handleStarted = (run: HarmonizeRunStatus) => {
    void queryClient.invalidateQueries({ queryKey: getListHarmonizeRunsQueryKey() });
    onStarted(run);
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-3xl">
        <SheetHeader className="mb-4">
          <SheetTitle>New harmonization run</SheetTitle>
          <SheetDescription>Choose what to harmonize. The run then opens in the workbench, where you review, flag and export.</SheetDescription>
        </SheetHeader>
        <Tabs value={tab} onValueChange={(v) => onTabChange(v as SetupTab)}>
          <TabsList className="mb-4">
            <TabsTrigger value="files">Upload cohort files</TabsTrigger>
            <TabsTrigger value="jobs">Finished mapping jobs</TabsTrigger>
            <TabsTrigger value="examples">Built-in examples</TabsTrigger>
          </TabsList>
          <TabsContent value="files">
            <UploadTab onStarted={handleStarted} />
          </TabsContent>
          <TabsContent value="jobs">
            <JobsTab onStarted={handleStarted} />
          </TabsContent>
          <TabsContent value="examples">
            <ExamplesTab onStarted={handleStarted} />
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
