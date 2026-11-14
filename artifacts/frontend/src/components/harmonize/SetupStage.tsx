import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Beaker, Database, Files, Layers, Loader2, Play, Plus } from "lucide-react";
import {
  getJob,
  getListEntityTypesQueryKey,
  getListHarmonizeRunsQueryKey,
  getListJobsQueryKey,
  inspectHarmonizeFile,
  submitHarmonizeCohorts,
  submitHarmonizeExample,
  submitHarmonizeFromJobs,
  submitHarmonizeMany,
  useListEntityTypes,
  useListJobs,
  type HarmonizeRunStatus,
  type JobDetail,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  MAX_COHORTS,
  categoryOrNull,
  cohortInput,
  distinctLabel,
  errorMessage,
  labelFromFilename,
  manyCountMessage,
  prefillDraft,
  type CohortDraft,
} from "@/lib/harmonize";
import { CohortEditor, EMPTY_INSPECT, FilePick, inspectOk, type CohortSlot } from "./CohortEditor";
import { Glossary, Note, Panel } from "./common";
import { stageHref } from "./StageRail";

type Mode = "two" | "many" | "jobs";

const DEFAULT_ENTITY = "biolink:SmallMolecule";
const FALLBACK_VOCABS = ["HMDB", "KEGG", "CHEBI", "PUBCHEM.COMPOUND", "INCHIKEY", "CAS", "LM", "RM", "UNIPROTKB", "NCBIGENE", "LOINC"];

let slotCounter = 0;
function newSlot(): CohortSlot {
  slotCounter += 1;
  return {
    id: `slot-${slotCounter}`,
    file: null,
    inspect: EMPTY_INSPECT,
    draft: { label: "", nameColumn: "", keyColumn: "", vocabByColumn: {} },
    labelTouched: false,
  };
}

const MODES: { mode: Mode; title: string; blurb: string; icon: typeof Files }[] = [
  { mode: "two", title: "Two cohort files", blurb: "Link the rows of two datasets.", icon: Files },
  { mode: "many", title: "Many cohort files", blurb: `Group the rows of 2 to ${MAX_COHORTS} datasets.`, icon: Layers },
  { mode: "jobs", title: "Two finished mapping jobs", blurb: "Harmonize jobs you already mapped. No re-mapping.", icon: Database },
];

/** The first stage of a new run: what to harmonize, the entity, and each cohort's columns. One primary action. */
export function SetupStage() {
  const [mode, setMode] = useState<Mode>("two");
  const [entity, setEntity] = useState(DEFAULT_ENTITY);
  const [category, setCategory] = useState("");
  const [remapAll, setRemapAll] = useState(false);
  const [twoSlots, setTwoSlots] = useState<CohortSlot[]>(() => [newSlot(), newSlot()]);
  const [manySlots, setManySlots] = useState<CohortSlot[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();

  const entityTypesQuery = useListEntityTypes({
    query: { queryKey: getListEntityTypesQueryKey(), staleTime: 60 * 60 * 1000, retry: 1 },
  });
  const entityTypes = entityTypesQuery.data ?? [];
  const vocabSuggestions = useMemo(() => {
    const preset = entityTypes.find((t) => t.type === entity)?.defaultPrefixes ?? [];
    return Array.from(new Set([...preset, ...FALLBACK_VOCABS]));
  }, [entityTypes, entity]);

  const slots = mode === "two" ? twoSlots : manySlots;
  const setSlots = mode === "two" ? setTwoSlots : setManySlots;

  // Inspect results arrive after the user may have edited the slot list; update by id.
  const updateSlot = (setter: typeof setTwoSlots, id: string, fn: (s: CohortSlot) => CohortSlot) =>
    setter((prev) => prev.map((s) => (s.id === id ? fn(s) : s)));

  // The label is chosen inside the state update, against the other slots' labels as they are then. Two files loaded
  // in the same tick (a two-file drop) each see the label the other was just given, so same-stem files get
  // distinct labels instead of two equal ones and a refused run.
  const loadFile = (setter: typeof setTwoSlots, id: string, file: File) => {
    setSubmitError(null);
    setter((prev) => {
      const taken = prev.filter((o) => o.id !== id).map((o) => o.draft.label);
      return prev.map((s) =>
        s.id !== id
          ? s
          : {
              ...s,
              file,
              inspect: { ...EMPTY_INSPECT, status: "loading" },
              draft: s.labelTouched ? s.draft : { ...s.draft, label: distinctLabel(labelFromFilename(file.name), taken) },
            },
      );
    });
    inspectHarmonizeFile({ file }).then(
      (res) => {
        const inspect = inspectOk(res.columns, res.rowCount);
        updateSlot(setter, id, (s) =>
          s.file !== file
            ? s
            : {
                ...s,
                inspect,
                draft: prefillDraft(s.draft, inspect.columns, vocabSuggestions, s.inspect.columns.length === 0 && !s.draft.nameColumn),
              },
        );
      },
      (err) =>
        updateSlot(setter, id, (s) =>
          s.file !== file ? s : { ...s, inspect: { status: "error", header: [], columns: [], rowCount: null, error: errorMessage(err) } },
        ),
    );
  };

  const addManyFiles = (files: File[]) => {
    const added = files.map(() => newSlot());
    setManySlots((prev) => [...prev, ...added]);
    files.forEach((file, i) => loadFile(setManySlots, added[i].id, file));
  };

  // Two-cohort mode takes several files at once: two fill both cohorts; one fills the first cohort without a file;
  // more than two cannot fit, so the screen offers many-cohort mode with those files instead of dropping any.
  const [tooMany, setTooMany] = useState<File[] | null>(null);
  const [pickNote, setPickNote] = useState<string | null>(null);
  const addTwoFiles = (files: File[]) => {
    setPickNote(null);
    setTooMany(null);
    if (files.length > 2) return setTooMany(files);
    if (files.length === 2) {
      loadFile(setTwoSlots, twoSlots[0].id, files[0]);
      loadFile(setTwoSlots, twoSlots[1].id, files[1]);
      return;
    }
    const empty = twoSlots.find((s) => !s.file);
    if (!empty) return setPickNote("Both cohorts already have a file. Use Replace file on a cohort to change its file.");
    loadFile(setTwoSlots, empty.id, files[0]);
  };
  const switchToMany = (files: File[]) => {
    setTooMany(null);
    setMode("many");
    setSubmitError(null);
    addManyFiles(files);
  };

  const started = (run: HarmonizeRunStatus) => {
    void queryClient.invalidateQueries({ queryKey: getListHarmonizeRunsQueryKey() });
    navigate(stageHref(run.jobId, run.state === "complete" ? "review" : "run"));
  };

  const submitCohorts = async () => {
    setSubmitError(null);
    const titles = mode === "two" ? ["Cohort A", "Cohort B"] : slots.map((_, i) => `Cohort ${i + 1}`);
    if (mode === "many") {
      const countMsg = manyCountMessage(slots.length);
      if (countMsg) {
        setSubmitError(countMsg);
        return;
      }
    }
    for (let i = 0; i < slots.length; i += 1) {
      if (!slots[i].file) return setSubmitError(`Choose a file for ${titles[i]}.`);
      if (slots[i].inspect.status === "error" && slots[i].inspect.error) return setSubmitError(slots[i].inspect.error);
      if (!slots[i].draft.nameColumn) return setSubmitError(`Pick the name column for ${titles[i]}.`);
    }
    const specBase = { entity, category: categoryOrNull(category) };
    setSubmitting(true);
    try {
      let run: HarmonizeRunStatus;
      if (mode === "two") {
        const [a, b] = slots;
        run = await submitHarmonizeCohorts({
          fileA: a.file!,
          fileB: b.file!,
          spec: JSON.stringify({ ...specBase, a: cohortInput(a.draft), b: cohortInput(b.draft) }),
        });
      } else {
        run = await submitHarmonizeMany({
          files: slots.map((s) => s.file!),
          spec: JSON.stringify({ ...specBase, remapAll, cohorts: slots.map((s) => cohortInput(s.draft)) }),
        });
      }
      started(run);
    } catch (err) {
      setSubmitError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <ExampleCard onStarted={started} />

      <Panel id="setup-kind" title="What do you want to harmonize?">
        <div role="radiogroup" aria-label="What to harmonize" className="grid gap-3 md:grid-cols-3">
          {MODES.map(({ mode: m, title, blurb, icon: Icon }) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => {
                setMode(m);
                setSubmitError(null);
              }}
              className={cn(
                "flex items-start gap-3 rounded border px-4 py-3 text-left transition-colors",
                mode === m ? "border-ph-navy bg-neutral-100 ring-1 ring-ph-navy" : "border-neutral-200 bg-white hover:bg-neutral-50",
              )}
            >
              <Icon aria-hidden className={cn("mt-0.5 h-5 w-5 shrink-0", mode === m ? "text-ph-navy" : "text-neutral-400")} />
              <span>
                <span className="block text-sm font-semibold text-neutral-900">{title}</span>
                <span className="block text-xs text-neutral-500">{blurb}</span>
              </span>
            </button>
          ))}
        </div>
      </Panel>

      {mode === "jobs" ? (
        <FromJobsForm onStarted={started} />
      ) : (
        <>
          <Panel
            id="setup-entity"
            title="Entity"
            description="One entity type per run. Name links apply to small molecules only; the run says whether they were on."
          >
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="harm-entity">Entity type</Label>
                <Select value={entity} onValueChange={setEntity} disabled={entityTypesQuery.isLoading}>
                  <SelectTrigger id="harm-entity" aria-label="Entity type">
                    <SelectValue placeholder={entityTypesQuery.isLoading ? "Loading entity types" : "Select entity type"} />
                  </SelectTrigger>
                  <SelectContent>
                    {!entityTypes.some((t) => t.type === entity) && <SelectItem value={entity}>{entity}</SelectItem>}
                    {entityTypes.map((t) => (
                      <SelectItem key={t.type} value={t.type}>
                        {t.type}
                        {t.aliases && t.aliases.length > 0 && <span className="ml-2 text-xs text-neutral-500">({t.aliases.join(", ")})</span>}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {entityTypesQuery.isError && (
                  <p className="text-xs text-warning">
                    The entity type list did not load ({errorMessage(entityTypesQuery.error)}). {DEFAULT_ENTITY} is selected.
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="harm-category">Category override (optional)</Label>
                <Input
                  id="harm-category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="e.g. biolink:ClinicalMeasurement"
                />
                <p className="text-xs text-neutral-500">Leave blank to use the entity type's own category. Sent as written.</p>
              </div>
            </div>
          </Panel>

          <Panel
            id="setup-cohorts"
            title={mode === "two" ? "Cohorts" : `Cohorts (${manySlots.length} of 2 to ${MAX_COHORTS})`}
            description="Panel metadata only: analyte names and identifier columns. Each file's header fills the column lists."
            actions={
              mode === "many" && manySlots.length > 0 ? (
                <Button type="button" variant="secondary" size="sm" onClick={() => setManySlots([])}>
                  Clear all
                </Button>
              ) : undefined
            }
          >
            <div className="space-y-4">
              {mode === "two" ? (
                <>
                <FilePick label="Choose both cohort files" multiple onFiles={addTwoFiles} testId="two-pick" />
                {pickNote && (
                  <Note tone="info" testId="two-pick-note">
                    {pickNote}
                  </Note>
                )}
                {tooMany && (
                  <Note
                    tone="warning"
                    title={`You chose ${tooMany.length} files`}
                    testId="two-pick-too-many"
                    action={
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" onClick={() => switchToMany(tooMany)}>
                          Switch to many cohorts with these {tooMany.length} files
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => setTooMany(null)}>
                          Keep two cohorts
                        </Button>
                      </div>
                    }
                  >
                    Two-cohort setup takes two files. Many-cohort setup takes 2 to {MAX_COHORTS}. None of these files has been added yet.
                  </Note>
                )}
                <div className="grid gap-4 xl:grid-cols-2">
                  {twoSlots.map((slot, i) => (
                    <CohortEditor
                      key={slot.id}
                      title={i === 0 ? "Cohort A" : "Cohort B"}
                      slot={slot}
                      vocabSuggestions={vocabSuggestions}
                      onFile={(file) => loadFile(setTwoSlots, slot.id, file)}
                      onManyFiles={addTwoFiles}
                      onChange={(draft: CohortDraft, touched) =>
                        updateSlot(setTwoSlots, slot.id, (s) => ({ ...s, draft, labelTouched: s.labelTouched || !!touched }))
                      }
                    />
                  ))}
                </div>
                </>
              ) : (
                <>
                  <FilePick label="Add cohort files" multiple onFiles={addManyFiles} testId="many-pick" />
                  {manySlots.length === 0 ? (
                    <p className="text-sm text-neutral-500">No cohort files yet. Add 2 to {MAX_COHORTS} files, one per cohort.</p>
                  ) : (
                    <div className="grid gap-4 xl:grid-cols-2">
                      {manySlots.map((slot, i) => (
                        <CohortEditor
                          key={slot.id}
                          title={`Cohort ${i + 1}`}
                          slot={slot}
                          compact
                          vocabSuggestions={vocabSuggestions}
                          onFile={(file) => loadFile(setManySlots, slot.id, file)}
                          onManyFiles={(files) => {
                            loadFile(setManySlots, slot.id, files[0]);
                            addManyFiles(files.slice(1));
                          }}
                          onChange={(draft: CohortDraft, touched) =>
                            updateSlot(setManySlots, slot.id, (s) => ({ ...s, draft, labelTouched: s.labelTouched || !!touched }))
                          }
                          onRemove={() => setManySlots((prev) => prev.filter((s) => s.id !== slot.id))}
                        />
                      ))}
                    </div>
                  )}
                  {manySlots.length > 0 && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => setManySlots((p) => [...p, newSlot()])}>
                      <Plus aria-hidden /> Add an empty cohort
                    </Button>
                  )}
                  <div className="flex items-start gap-3 rounded border border-neutral-200 bg-neutral-50 px-4 py-3">
                    <Checkbox id="harm-remap" aria-label="Remap all rows" checked={remapAll} onCheckedChange={(v) => setRemapAll(v === true)} />
                    <div>
                      <Label htmlFor="harm-remap" className="text-sm text-neutral-900">
                        Remap all rows
                      </Label>
                      <p className="mt-1 text-xs text-neutral-500">Map every row again instead of reusing saved mappings.</p>
                    </div>
                  </div>
                </>
              )}
            </div>
          </Panel>

          <Glossary terms={["keyColumn", "category"]} />

          <StartBar
            submitting={submitting}
            error={submitError}
            onStart={submitCohorts}
            summary={
              mode === "two"
                ? `Two cohorts, ${entity}`
                : `${manySlots.length} ${manySlots.length === 1 ? "cohort" : "cohorts"}, ${entity}${remapAll ? ", remap all" : ""}`
            }
          />
        </>
      )}
    </div>
  );
}

function StartBar({
  submitting,
  error,
  onStart,
  summary,
  label = "Start harmonization",
}: {
  submitting: boolean;
  error: string | null;
  onStart: () => void;
  summary: string;
  label?: string;
}) {
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "nearest" });
  }, [error]);
  return (
    <div className="space-y-3">
      {error && (
        <div ref={errorRef}>
          <Note tone="danger" title="The run did not start" testId="submit-error">
            {error}
          </Note>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-neutral-200 bg-neutral-50 px-5 py-3">
        <p className="text-sm text-neutral-600">{summary}</p>
        <Button size="lg" onClick={onStart} disabled={submitting}>
          {submitting ? <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" /> : <Play aria-hidden />}
          {submitting ? "Starting" : label}
        </Button>
      </div>
    </div>
  );
}

/** The built-in examples: each one action, no files to pick. */
function ExampleCard({ onStarted }: { onStarted: (run: HarmonizeRunStatus) => void }) {
  const [pending, setPending] = useState<"two_cohort" | "many_cohort" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (kind: "two_cohort" | "many_cohort") => {
    setPending(kind);
    setError(null);
    try {
      onStarted(await submitHarmonizeExample({ kind }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(null);
    }
  };
  return (
    <div className="rounded border border-neutral-200 bg-neutral-50 px-5 py-4" data-testid="example-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <Beaker aria-hidden className="mt-0.5 h-5 w-5 text-neutral-400" />
          <div>
            <p className="text-sm font-semibold text-neutral-900">New to harmonization? Run a built-in example</p>
            <p className="text-xs text-neutral-500">
              Invented metabolite panels: two cohorts of 30 rows, or five cohorts of 16 rows. No files needed.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" disabled={pending !== null} onClick={() => run("two_cohort")}>
            {pending === "two_cohort" && <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" />}
            Run the two-cohort example
          </Button>
          <Button variant="secondary" size="sm" disabled={pending !== null} onClick={() => run("many_cohort")}>
            {pending === "many_cohort" && <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" />}
            Run the many-cohort example
          </Button>
        </div>
      </div>
      {error && (
        <Note tone="danger" title="The example did not start" className="mt-3">
          {error}
        </Note>
      )}
    </div>
  );
}

const JOB_DEFAULT_ENTITY = "biolink:SmallMolecule";

/** The job's entity type as GET /jobs/{id} reports it (config.entityType), or null when the job has no config. */
function jobEntityType(job: JobDetail | undefined): string | null {
  return job?.config?.entityType ?? null;
}

const JOB_STATUS_WORD: Record<string, string> = {
  pending: "not started",
  processing: "still mapping",
  error: "failed",
  complete: "finished",
};

/** Harmonize two of the user's finished mapping jobs (offline, complete as soon as it starts). */
function FromJobsForm({ onStarted }: { onStarted: (run: HarmonizeRunStatus) => void }) {
  const jobsQuery = useListJobs({ query: { queryKey: getListJobsQueryKey(), retry: 1 } });
  const jobs = jobsQuery.data ?? [];
  const [jobA, setJobA] = useState("");
  const [jobB, setJobB] = useState("");
  const [aLabel, setALabel] = useState("");
  const [bLabel, setBLabel] = useState("");
  const [touched, setTouched] = useState({ a: false, b: false });
  const [linkByName, setLinkByName] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detailA = useQuery({ queryKey: ["/api/jobs", jobA, "entity"], queryFn: () => getJob(jobA), enabled: !!jobA, staleTime: 60_000 });
  const detailB = useQuery({ queryKey: ["/api/jobs", jobB, "entity"], queryFn: () => getJob(jobB), enabled: !!jobB, staleTime: 60_000 });

  const labelFor = (jobId: string) => {
    const j = jobs.find((x) => x.jobId === jobId);
    return labelFromFilename(j?.displayName || jobId.slice(0, 8));
  };
  const pick = (side: "a" | "b", jobId: string) => {
    setError(null);
    if (side === "a") {
      setJobA(jobId);
      if (!touched.a) setALabel(distinctLabel(labelFor(jobId), [bLabel]));
    } else {
      setJobB(jobId);
      if (!touched.b) setBLabel(distinctLabel(labelFor(jobId), [aLabel]));
    }
  };

  const submit = async () => {
    setError(null);
    if (!jobA || !jobB) return setError("Choose two finished mapping jobs.");
    setSubmitting(true);
    try {
      onStarted(await submitHarmonizeFromJobs({ jobA, jobB, aLabel, bLabel, linkByName }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const finished = jobs.filter((j) => j.status === "complete");
  // Both entity types known and different: the server will refuse the pair, so say so before submit.
  const entityA = detailA.data ? (jobEntityType(detailA.data) ?? JOB_DEFAULT_ENTITY) : null;
  const entityB = detailB.data ? (jobEntityType(detailB.data) ?? JOB_DEFAULT_ENTITY) : null;
  const entityMismatch = !!jobA && !!jobB && entityA !== null && entityB !== null && entityA !== entityB;

  const side = (key: "a" | "b") => {
    const value = key === "a" ? jobA : jobB;
    const detail = key === "a" ? detailA : detailB;
    const label = key === "a" ? aLabel : bLabel;
    const setLabel = key === "a" ? setALabel : setBLabel;
    const title = key === "a" ? "Job A" : "Job B";
    const entity = jobEntityType(detail.data);
    return (
      <div className="space-y-3 rounded border border-neutral-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-neutral-900">{title}</h3>
        <div className="space-y-1.5">
          <Label htmlFor={`fj-${key}`}>Mapping job</Label>
          <Select value={value || undefined} onValueChange={(v) => pick(key, v)}>
            <SelectTrigger id={`fj-${key}`} aria-label={`Mapping job for ${title}`}>
              <SelectValue placeholder="Choose a finished job" />
            </SelectTrigger>
            <SelectContent>
              {jobs.map((j) => (
                <SelectItem key={j.jobId} value={j.jobId} disabled={j.status !== "complete"}>
                  {j.displayName || `${j.jobId.slice(0, 8)}...`}
                  <span className="ml-2 text-xs text-neutral-500">
                    {j.total.toLocaleString()} names, {JOB_STATUS_WORD[j.status] ?? j.status}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {value && (
            <p className="text-xs text-neutral-500" data-testid={`fj-${key}-entity`}>
              {detail.isLoading
                ? "Reading the job's entity type"
                : detail.isError
                  ? `Could not read the job: ${errorMessage(detail.error)}`
                  : `Entity type: ${entity ?? `${JOB_DEFAULT_ENTITY} (the default)`}`}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`fj-${key}-label`}>Label</Label>
          <Input
            id={`fj-${key}-label`}
            aria-label={`Label for ${title}`}
            value={label}
            placeholder="e.g. arivale_2024"
            onChange={(e) => {
              setLabel(e.target.value);
              setTouched((t) => ({ ...t, [key]: true }));
            }}
          />
        </div>
      </div>
    );
  };

  return (
    <>
      <Panel
        id="setup-jobs"
        title="Finished mapping jobs"
        description="Choose two jobs you mapped in entity resolution, of the same entity type. Only finished jobs can be chosen."
      >
        {jobsQuery.isLoading ? (
          <p className="text-sm text-neutral-500" role="status">Loading your mapping jobs</p>
        ) : jobsQuery.isError ? (
          <Note tone="danger" title="Your mapping jobs did not load" action={<Button size="sm" variant="secondary" onClick={() => jobsQuery.refetch()}>Try again</Button>}>
            {errorMessage(jobsQuery.error)}
          </Note>
        ) : finished.length === 0 ? (
          <Note tone="info" title="No finished mapping jobs yet">
            Map two panel files in entity resolution (New job in the left rail), wait for both to finish, then come back.
            {jobs.length > 0 && ` You have ${jobs.length} job${jobs.length === 1 ? "" : "s"} that ${jobs.length === 1 ? "has" : "have"} not finished.`}
          </Note>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-4 lg:grid-cols-2">
              {side("a")}
              {side("b")}
            </div>
            {entityMismatch && (
              <Note tone="warning" title="These two jobs map different entity types" testId="fj-entity-mismatch">
                Job A is {entityA} and Job B is {entityB}. A run takes two jobs of the same entity type, so this pair will
                be refused. Choose another job for one side.
              </Note>
            )}
            <div className="flex items-start gap-3 rounded border border-neutral-200 bg-neutral-50 px-4 py-3">
              <Switch id="fj-link-by-name" aria-label="Link by name" checked={linkByName} onCheckedChange={setLinkByName} aria-describedby="fj-link-by-name-help" />
              <div>
                <Label htmlFor="fj-link-by-name" className="text-sm text-neutral-900">
                  Link by name
                </Label>
                <p id="fj-link-by-name-help" className="mt-1 text-xs text-neutral-500">
                  Off: rows link only when they resolved to the same node or share an identifier. On: two resolved rows whose
                  names are equal are also linked. The run records your choice.
                </p>
              </div>
            </div>
          </div>
        )}
      </Panel>
      <StartBar
        submitting={submitting}
        error={error}
        onStart={submit}
        label="Harmonize these jobs"
        summary={`Two finished jobs, link by name ${linkByName ? "on" : "off"}`}
      />
    </>
  );
}
