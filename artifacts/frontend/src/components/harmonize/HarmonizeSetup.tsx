import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import { useQueryClient } from "@tanstack/react-query";
import {
  inspectHarmonizeFile,
  useListEntityTypes,
  getListEntityTypesQueryKey,
  useListJobs,
  getListJobsQueryKey,
  useGetJob,
  getGetJobQueryKey,
  useSubmitHarmonizeCohorts,
  useSubmitHarmonizeMany,
  useSubmitHarmonizeExample,
  useSubmitHarmonizeFromJobs,
  getListHarmonizeRunsQueryKey,
  type HarmonizeRunStatus,
  type EntityType,
} from "@workspace/api-client-react";
import { Beaker, FileType, Loader2, Play, RefreshCw, Trash2, UploadCloud } from "lucide-react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FieldTooltip } from "@/components/field-tooltip";
import { Notice } from "@/components/harmonize/common";
import {
  MAX_FILE_BYTES,
  MAX_MANY,
  MAX_ROWS,
  MIN_MANY,
  distinctLabels,
  errorMessage,
  guessKeyColumn,
  guessNameColumn,
  inferVocabulary,
  isValidLabel,
  labelFromName,
  manyCountMessage,
  missingColumns,
  toCohortInput,
  tooLargeMessage,
  tooManyRowsMessage,
} from "@/lib/harmonize";

export type SetupMode = "two" | "many" | "jobs";

type Inspect =
  | { state: "loading" }
  | { state: "ok"; columns: string[]; rowCount: number }
  | { state: "error"; message: string };

interface CohortDraft {
  id: string;
  file: File;
  inspect: Inspect;
  label: string;
  nameColumn: string;
  keyColumn: string;
  idColumns: Record<string, string>;
}

const DEFAULT_ENTITY = "biolink:SmallMolecule";
const NO_KEY = "__none__";
let draftSeq = 0;

function freshDraft(file: File, label: string): CohortDraft {
  draftSeq += 1;
  return { id: `c${draftSeq}`, file, inspect: { state: "loading" }, label, nameColumn: "", keyColumn: "", idColumns: {} };
}

/** Defaults from the file's header, used when a cohort has no column choices yet. */
function withHeaderDefaults(d: CohortDraft, columns: string[]): CohortDraft {
  const nameColumn = guessNameColumn(columns);
  const keyColumn = guessKeyColumn(columns, nameColumn);
  const idColumns: Record<string, string> = {};
  for (const c of columns) {
    if (c === nameColumn || c === keyColumn) continue;
    const vocab = inferVocabulary(c);
    if (vocab) idColumns[c] = vocab;
  }
  return { ...d, nameColumn, keyColumn, idColumns };
}

const COHORT_LETTERS = "ABCDEFGHIJKL";

export function HarmonizeSetup({
  onStarted,
  mode,
  onModeChange,
}: {
  onStarted: (run: HarmonizeRunStatus) => void;
  mode: SetupMode;
  onModeChange: (m: SetupMode) => void;
}) {
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<CohortDraft[]>([]);
  const [entity, setEntity] = useState(DEFAULT_ENTITY);
  const [category, setCategory] = useState("");
  const [remapAll, setRemapAll] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [exampleError, setExampleError] = useState<string | null>(null);

  const entityTypesQuery = useListEntityTypes({
    query: { queryKey: getListEntityTypesQueryKey(), staleTime: 60 * 60 * 1000, retry: 1 },
  });

  const afterStart = (run: HarmonizeRunStatus) => {
    setSubmitError(null);
    setExampleError(null);
    void queryClient.invalidateQueries({ queryKey: getListHarmonizeRunsQueryKey() });
    onStarted(run);
  };

  const submitTwo = useSubmitHarmonizeCohorts({
    mutation: { onSuccess: afterStart, onError: (e) => setSubmitError(errorMessage(e)) },
  });
  const submitMany = useSubmitHarmonizeMany({
    mutation: { onSuccess: afterStart, onError: (e) => setSubmitError(errorMessage(e)) },
  });
  const submitExample = useSubmitHarmonizeExample({
    mutation: { onSuccess: afterStart, onError: (e) => setExampleError(errorMessage(e)) },
  });

  // ---- files -------------------------------------------------------------

  const runInspect = useCallback((id: string, file: File, keepConfig: boolean) => {
    if (file.size > MAX_FILE_BYTES) {
      setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, inspect: { state: "error", message: tooLargeMessage(file.name) } } : d)));
      return;
    }
    inspectHarmonizeFile({ file })
      .then((res) => {
        setDrafts((prev) =>
          prev.map((d) => {
            if (d.id !== id || d.file !== file) return d;
            const next = { ...d, inspect: { state: "ok" as const, columns: res.columns, rowCount: res.rowCount } };
            return keepConfig && d.nameColumn ? next : withHeaderDefaults(next, res.columns);
          }),
        );
      })
      .catch((err) => {
        setDrafts((prev) =>
          prev.map((d) => (d.id === id && d.file === file ? { ...d, inspect: { state: "error", message: errorMessage(err) } } : d)),
        );
      });
  }, []);

  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      setSubmitError(null);
      const taken = draftsRef.current.map((d) => d.label);
      const labels = distinctLabels([...taken, ...files.map((f) => f.name)]).slice(taken.length);
      const added = files.map((f, i) => freshDraft(f, labels[i]));
      setDrafts((prev) => [...prev, ...added]);
      added.forEach((d) => runInspect(d.id, d.file, false));
    },
    [runInspect],
  );

  const replaceFile = (id: string, file: File) => {
    setSubmitError(null);
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, file, inspect: { state: "loading" } } : d)));
    runInspect(id, file, true);
  };

  const removeDraft = (id: string) => {
    setSubmitError(null);
    setDrafts((prev) => prev.filter((d) => d.id !== id));
  };

  const updateDraft = (id: string, patch: Partial<CohortDraft>) => {
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  };

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop: addFiles,
    accept: { "text/csv": [".csv"], "text/tab-separated-values": [".tsv"], "text/plain": [".txt", ".tsv", ".csv"] },
    multiple: true,
    noClick: true,
    noKeyboard: true,
  });

  // ---- start -------------------------------------------------------------

  const allInspected = drafts.length > 0 && drafts.every((d) => d.inspect.state === "ok");
  const anyLoading = drafts.some((d) => d.inspect.state === "loading");
  const countProblem =
    mode === "two"
      ? drafts.length !== 2
        ? drafts.length < 2
          ? `Choose ${2 - drafts.length === 2 ? "two cohort files" : "one more cohort file"}.`
          : `A two-cohort run takes exactly two files (you chose ${drafts.length}). Remove ${drafts.length - 2}, or switch to Many cohorts.`
        : null
      : mode === "many" && drafts.length > 0 && (drafts.length < MIN_MANY || drafts.length > MAX_MANY)
        ? manyCountMessage(drafts.length)
        : mode === "many" && drafts.length === 0
          ? `Choose ${MIN_MANY} to ${MAX_MANY} cohort files.`
          : null;
  const blocker =
    countProblem ??
    (anyLoading ? "Reading the files..." : !allInspected ? "Fix or remove the files that could not be read." : null) ??
    (drafts.some((d) => !d.nameColumn) ? "Pick a name column for every cohort." : null) ??
    (!entity ? "Choose an entity type." : null);

  const isSubmitting = submitTwo.isPending || submitMany.isPending;

  const start = () => {
    setSubmitError(null);
    const inputs = drafts.map((d) => toCohortInput(d));
    const shared = { entity, ...(category.trim() ? { category: category.trim() } : {}) };
    if (mode === "two") {
      submitTwo.mutate({
        data: { fileA: drafts[0].file, fileB: drafts[1].file, spec: JSON.stringify({ ...shared, a: inputs[0], b: inputs[1] }) },
      });
    } else {
      submitMany.mutate({
        data: { files: drafts.map((d) => d.file), spec: JSON.stringify({ ...shared, remapAll, cohorts: inputs }) },
      });
    }
  };

  // Clear a stale refusal when the user changes the setup it was about.
  useEffect(() => setSubmitError(null), [mode]);

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={mode} onValueChange={(v) => onModeChange(v as SetupMode)}>
          <TabsList aria-label="What to harmonize">
            <TabsTrigger value="two" data-testid="mode-two">Two cohorts</TabsTrigger>
            <TabsTrigger value="many" data-testid="mode-many">Many cohorts</TabsTrigger>
            <TabsTrigger value="jobs" data-testid="mode-jobs">Finished jobs</TabsTrigger>
          </TabsList>
        </Tabs>
        <FieldTooltip label="Help: What to harmonize">
          Two cohorts links the rows of two files. Many cohorts groups the rows of 2 to 12 files around shared
          knowledge-graph nodes. Finished jobs harmonizes two mapping jobs you already ran in entity resolution,
          without mapping again.
        </FieldTooltip>
      </div>

      <ExampleStrip
        pending={submitExample.isPending ? submitExample.variables?.data.kind ?? null : null}
        error={exampleError}
        onRun={(kind) => {
          setExampleError(null);
          submitExample.mutate({ data: { kind } });
        }}
      />

      {mode === "jobs" ? (
        <FromJobsSetup onStarted={afterStart} />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>1. Choose cohort files</CardTitle>
              <CardDescription>
                {mode === "two"
                  ? "Two panel metadata files (CSV or TSV): analyte names and any identifier columns."
                  : `${MIN_MANY} to ${MAX_MANY} panel metadata files (CSV or TSV), one per cohort.`}{" "}
                Up to 50 MB and {MAX_ROWS.toLocaleString()} rows each.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div
                {...getRootProps()}
                className={`rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
                  isDragActive ? "border-ph-navy bg-ph-navy/5" : "border-neutral-200"
                }`}
                data-testid="cohort-dropzone"
              >
                <input {...getInputProps()} aria-label="Cohort files" data-testid="cohort-file-input" />
                <div className="flex flex-col items-center gap-2">
                  <UploadCloud aria-hidden className="h-6 w-6 text-neutral-500" />
                  <p className="text-sm font-medium text-neutral-900">Drag cohort files here, or</p>
                  <Button type="button" variant="outline" size="sm" onClick={open} data-testid="btn-choose-files">
                    Choose cohort files
                  </Button>
                  <p className="text-xs text-neutral-500">Supported formats: .csv, .tsv, .txt</p>
                </div>
              </div>

              {drafts.length > 0 && (
                <div className="grid gap-4" data-testid="cohort-cards">
                  {drafts.map((d, i) => (
                    <CohortCard
                      key={d.id}
                      draft={d}
                      title={`Cohort ${COHORT_LETTERS[i] ?? i + 1}`}
                      vocabSuggestions={entityTypesQuery.data?.find((t) => t.type === entity)?.defaultPrefixes ?? []}
                      onChange={(patch) => updateDraft(d.id, patch)}
                      onReplace={(f) => replaceFile(d.id, f)}
                      onRemove={() => removeDraft(d.id)}
                    />
                  ))}
                </div>
              )}

              {mode === "two" && drafts.length > 2 && (
                <Notice
                  tone="warning"
                  action={
                    <Button size="sm" variant="secondary" onClick={() => onModeChange("many")}>
                      Switch to Many cohorts
                    </Button>
                  }
                >
                  A two-cohort run takes exactly two files. You chose {drafts.length}.
                </Notice>
              )}
              {mode === "many" && drafts.length > 0 && (drafts.length < MIN_MANY || drafts.length > MAX_MANY) && (
                <Notice tone="danger" testId="many-count-message">{manyCountMessage(drafts.length)}</Notice>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>2. Configure the run</CardTitle>
              <CardDescription>The entity type applies to every cohort in the run.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <EntityPicker
                value={entity}
                onChange={setEntity}
                types={entityTypesQuery.data}
                loading={entityTypesQuery.isLoading}
                failed={entityTypesQuery.isError}
              />
              <div className="space-y-2">
                <Label htmlFor="harm-category">
                  Category override
                  <FieldTooltip label="Help: Category override">
                    Optional. A Biolink category that replaces the one the entity type resolves to, passed through as
                    written. Leave it blank to use the entity type's own category.
                  </FieldTooltip>
                  <span className="ml-1 text-xs font-normal text-neutral-500">(optional)</span>
                </Label>
                <Input
                  id="harm-category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="e.g. biolink:SmallMolecule"
                  className="max-w-md font-mono"
                  data-testid="input-category"
                />
              </div>
              <p className="text-xs text-neutral-500">
                Name linking (linking rows whose names match even when they resolved to different nodes) is decided by
                the category and cannot be switched here. Each run says whether it was on and why.
              </p>
              {mode === "many" && (
                <div className="flex items-start gap-2">
                  <Checkbox
                    id="harm-remap-all"
                    checked={remapAll}
                    onCheckedChange={(v) => setRemapAll(v === true)}
                    data-testid="checkbox-remap-all"
                    className="mt-0.5"
                  />
                  <Label htmlFor="harm-remap-all" className="cursor-pointer font-normal">
                    Remap all rows
                    <span className="block text-xs text-neutral-500">
                      Map every row again instead of reusing saved mappings.
                    </span>
                  </Label>
                </div>
              )}
            </CardContent>
            <CardFooter className="flex flex-col items-stretch gap-3 border-t bg-neutral-50 py-4">
              {submitError && (
                <Notice tone="danger" title="The run was not started" testId="submit-error">
                  {submitError}
                </Notice>
              )}
              <div className="flex items-center justify-end gap-3">
                {blocker && <p className="text-sm text-neutral-500" data-testid="start-blocker">{blocker}</p>}
                <Button size="lg" onClick={start} disabled={!!blocker || isSubmitting} data-testid="btn-start-run">
                  {isSubmitting ? (
                    <>
                      <Loader2 className="animate-spin" /> Starting run...
                    </>
                  ) : (
                    <>
                      <Play /> {mode === "two" ? "Start two-cohort run" : "Start many-cohort run"}
                    </>
                  )}
                </Button>
              </div>
            </CardFooter>
          </Card>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ExampleStrip({
  pending,
  error,
  onRun,
}: {
  pending: string | null;
  error: string | null;
  onRun: (kind: "two_cohort" | "many_cohort") => void;
}) {
  return (
    <div className="rounded border border-neutral-200 bg-white px-4 py-3" data-testid="example-strip">
      <div className="flex flex-wrap items-center gap-3">
        <Beaker aria-hidden className="h-4 w-4 text-neutral-500" />
        <p className="text-sm text-neutral-700">No files at hand? Run a built-in example:</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => onRun("two_cohort")} disabled={pending !== null} data-testid="btn-example-two">
            {pending === "two_cohort" && <Loader2 className="animate-spin" />}
            Two-cohort example
          </Button>
          <Button variant="outline" size="sm" onClick={() => onRun("many_cohort")} disabled={pending !== null} data-testid="btn-example-many">
            {pending === "many_cohort" && <Loader2 className="animate-spin" />}
            Many-cohort example
          </Button>
        </div>
      </div>
      <p className="mt-1 text-xs text-neutral-500">
        Invented cohorts built from public metabolite names and identifiers: 2 cohorts of 30 rows, or 5 cohorts of 16.
      </p>
      {error && (
        <Notice tone="danger" className="mt-3" testId="example-error">
          {error}
        </Notice>
      )}
    </div>
  );
}

function EntityPicker({
  value,
  onChange,
  types,
  loading,
  failed,
  id = "harm-entity",
}: {
  value: string;
  onChange: (v: string) => void;
  types: EntityType[] | undefined;
  loading: boolean;
  failed: boolean;
  id?: string;
}) {
  const list = types && types.length > 0 ? types : [{ type: DEFAULT_ENTITY, aliases: ["metabolite"] }];
  const common = list.filter((t) => (t.aliases ?? []).length > 0);
  const rest = list.filter((t) => (t.aliases ?? []).length === 0);
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        Entity type
        <FieldTooltip label="Help: Entity type">
          What the rows are: metabolites, proteins, genes, clinical labs and so on. One entity type per run.
        </FieldTooltip>
      </Label>
      <Select value={value} onValueChange={onChange} disabled={loading}>
        <SelectTrigger id={id} className="max-w-md" data-testid="select-entity">
          <SelectValue placeholder={loading ? "Loading entity types..." : "Choose an entity type"} />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Common</SelectLabel>
            {common.map((t) => (
              <SelectItem key={t.type} value={t.type}>
                {t.type}
                <span className="ml-2 text-xs text-neutral-500">({(t.aliases ?? []).join(", ")})</span>
              </SelectItem>
            ))}
          </SelectGroup>
          {rest.length > 0 && (
            <SelectGroup>
              <SelectLabel>All Biolink types</SelectLabel>
              {rest.map((t) => (
                <SelectItem key={t.type} value={t.type}>
                  {t.type}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
        </SelectContent>
      </Select>
      {failed && (
        <p className="text-xs text-warning">Couldn't load the entity type list. You can still run with {DEFAULT_ENTITY}.</p>
      )}
    </div>
  );
}

function CohortCard({
  draft,
  title,
  vocabSuggestions,
  onChange,
  onReplace,
  onRemove,
}: {
  draft: CohortDraft;
  title: string;
  vocabSuggestions: string[];
  onChange: (patch: Partial<CohortDraft>) => void;
  onReplace: (f: File) => void;
  onRemove: () => void;
}) {
  const replaceInput = useRef<HTMLInputElement>(null);
  const { inspect } = draft;
  const columns = inspect.state === "ok" ? inspect.columns : [];
  const missing = inspect.state === "ok" ? missingColumns(draft, draft.file.name, columns) : [];
  const labelOk = isValidLabel(draft.label.trim());
  const listId = `vocab-suggestions-${draft.id}`;
  const otherColumns = columns.filter((c) => c !== draft.nameColumn && c !== draft.keyColumn);
  const shortName = draft.label || labelFromName(draft.file.name);

  return (
    <section
      aria-label={`${title}: ${draft.file.name}`}
      className="rounded border border-neutral-200 p-4"
      data-testid="cohort-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ph-navy/10 text-ph-navy">
            <FileType aria-hidden className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wider text-neutral-500">{title}</p>
            <p className="truncate font-medium text-neutral-900" title={draft.file.name}>{draft.file.name}</p>
            <p className="text-xs text-neutral-500 tabular-nums" data-testid="cohort-file-facts">
              {inspect.state === "ok"
                ? `${inspect.rowCount.toLocaleString()} row${inspect.rowCount === 1 ? "" : "s"}, ${columns.length} column${columns.length === 1 ? "" : "s"}`
                : inspect.state === "loading"
                  ? "Reading header..."
                  : "Could not be read"}
              {" · "}
              {(draft.file.size / 1024).toFixed(1)} KB
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <input
            ref={replaceInput}
            type="file"
            accept=".csv,.tsv,.txt"
            className="sr-only"
            tabIndex={-1}
            aria-label={`Replace file for ${title}`}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onReplace(f);
              e.target.value = "";
            }}
          />
          <Button variant="outline" size="sm" onClick={() => replaceInput.current?.click()} aria-label={`Replace ${draft.file.name}`}>
            <RefreshCw /> Replace
          </Button>
          <Button variant="ghost" size="sm" onClick={onRemove} aria-label={`Remove ${draft.file.name}`}>
            <Trash2 /> Remove
          </Button>
        </div>
      </div>

      {inspect.state === "loading" && (
        <div className="mt-4 h-4 w-1/2 animate-pulse rounded bg-neutral-100" role="status" aria-label="Reading file header" />
      )}
      {inspect.state === "error" && (
        <Notice tone="danger" className="mt-4" testId="inspect-error">{inspect.message}</Notice>
      )}

      {inspect.state === "ok" && (
        <div className="mt-4 space-y-4">
          <div>
            <p className="mb-1 text-xs font-medium text-neutral-500">Columns in this file</p>
            <div className="flex max-h-24 flex-wrap gap-1.5 scroll-visible [scrollbar-gutter:auto]!" data-testid="cohort-columns">
              {columns.map((c) => (
                <Badge key={c} variant="outline" className="font-mono">{c}</Badge>
              ))}
              {columns.length === 0 && <span className="text-xs text-neutral-500">The header is empty.</span>}
            </div>
          </div>

          {inspect.rowCount > MAX_ROWS && (
            <Notice tone="warning">{tooManyRowsMessage(draft.file.name, inspect.rowCount)}</Notice>
          )}
          {missing.map((m) => (
            <Notice key={m} tone="warning" testId="missing-column">{m}</Notice>
          ))}

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor={`label-${draft.id}`}>Cohort label</Label>
              <Input
                id={`label-${draft.id}`}
                value={draft.label}
                onChange={(e) => onChange({ label: e.target.value })}
                aria-invalid={!labelOk}
                className="font-mono"
                data-testid="input-cohort-label"
              />
              {!labelOk && (
                <p className="text-xs text-warning">Letters, digits, '.', '-' and '_' only.</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`name-col-${draft.id}`}>Name column</Label>
              <Select value={draft.nameColumn} onValueChange={(v) => {
                const idColumns = { ...draft.idColumns };
                delete idColumns[v];
                onChange({ nameColumn: v, keyColumn: draft.keyColumn === v ? "" : draft.keyColumn, idColumns });
              }}>
                <SelectTrigger id={`name-col-${draft.id}`} aria-label={`Name column for ${shortName}`} data-testid="select-name-column">
                  <SelectValue placeholder="Choose a column" />
                </SelectTrigger>
                <SelectContent>
                  {columns.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`key-col-${draft.id}`}>
                Key column <span className="text-xs font-normal text-neutral-500">(optional)</span>
              </Label>
              <Select value={draft.keyColumn || NO_KEY} onValueChange={(v) => {
                const key = v === NO_KEY ? "" : v;
                const idColumns = { ...draft.idColumns };
                if (key) delete idColumns[key];
                onChange({ keyColumn: key, idColumns });
              }}>
                <SelectTrigger id={`key-col-${draft.id}`} aria-label={`Key column for ${shortName}`} data-testid="select-key-column">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_KEY}>No key column (row number and name)</SelectItem>
                  {columns.filter((c) => c !== draft.nameColumn).map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium text-neutral-900">
              Identifier columns
              <FieldTooltip label="Help: Identifier columns">
                Tick each column that holds identifiers and name its vocabulary (for example HMDB). Several columns
                can share one vocabulary. Vocabularies both cohorts declare are used for mapping; the others are
                compared with the name results for review.
              </FieldTooltip>
            </p>
            {otherColumns.length === 0 ? (
              <p className="text-xs text-neutral-500">No other columns in this file.</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2" data-testid="id-columns">
                <datalist id={listId}>
                  {vocabSuggestions.map((v) => (
                    <option key={v} value={v} />
                  ))}
                </datalist>
                {otherColumns.map((c) => {
                  const on = c in draft.idColumns;
                  return (
                    <div key={c} className="flex min-w-0 items-center gap-2">
                      <Checkbox
                        id={`id-${draft.id}-${c}`}
                        checked={on}
                        onCheckedChange={(v) => {
                          const idColumns = { ...draft.idColumns };
                          if (v === true) idColumns[c] = inferVocabulary(c) ?? c.trim().toUpperCase();
                          else delete idColumns[c];
                          onChange({ idColumns });
                        }}
                        aria-label={`Use ${c} as an identifier column in ${shortName}`}
                      />
                      <Label htmlFor={`id-${draft.id}-${c}`} className="shrink-0 cursor-pointer font-mono font-normal">
                        {c}
                      </Label>
                      {on && (
                        <>
                          <span aria-hidden className="text-neutral-400">holds</span>
                          <Input
                            list={listId}
                            value={draft.idColumns[c]}
                            onChange={(e) => onChange({ idColumns: { ...draft.idColumns, [c]: e.target.value } })}
                            className="h-7 w-40 px-2 font-mono text-xs"
                            aria-label={`Vocabulary held by ${c} in ${shortName}`}
                            placeholder="e.g. HMDB"
                          />
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

function FromJobsSetup({ onStarted }: { onStarted: (run: HarmonizeRunStatus) => void }) {
  const jobsQuery = useListJobs({ query: { queryKey: getListJobsQueryKey(), retry: 1 } });
  const [jobA, setJobA] = useState("");
  const [jobB, setJobB] = useState("");
  const [aLabel, setALabel] = useState("");
  const [bLabel, setBLabel] = useState("");
  const [linkByName, setLinkByName] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = useSubmitHarmonizeFromJobs({
    mutation: { onSuccess: (run) => { setError(null); onStarted(run); }, onError: (e) => setError(errorMessage(e)) },
  });

  const jobs = useMemo(() => jobsQuery.data ?? [], [jobsQuery.data]);
  const name = (id: string) => {
    const j = jobs.find((x) => x.jobId === id);
    return j?.displayName || (id ? `Job ${id.slice(0, 8)}` : "");
  };
  const pick = (side: "a" | "b", id: string) => {
    setError(null);
    const label = labelFromName(name(id));
    if (side === "a") {
      setJobA(id);
      setALabel(label === labelFromName(name(jobB)) ? `${label}_a` : label);
    } else {
      setJobB(id);
      setBLabel(label === labelFromName(name(jobA)) ? `${label}_b` : label);
    }
  };

  const blocker = !jobA || !jobB
    ? "Choose two finished mapping jobs."
    : !aLabel.trim() || !bLabel.trim()
      ? "Give each side a label."
      : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Harmonize two finished mapping jobs</CardTitle>
        <CardDescription>
          Links the rows of two entity-resolution jobs you already ran, with no new mapping. Only finished jobs of the
          same entity type can be harmonized. The result is ready as soon as you start.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {jobsQuery.isLoading ? (
          <div className="space-y-2" role="status" aria-label="Loading your mapping jobs">
            <div className="h-9 w-full max-w-md animate-pulse rounded bg-neutral-100" />
            <div className="h-9 w-full max-w-md animate-pulse rounded bg-neutral-100" />
          </div>
        ) : jobsQuery.isError ? (
          <Notice tone="danger" title="Couldn't load your mapping jobs" action={
            <Button size="sm" variant="secondary" onClick={() => void jobsQuery.refetch()}>Try again</Button>
          }>
            {errorMessage(jobsQuery.error)}
          </Notice>
        ) : jobs.length === 0 ? (
          <Notice tone="info" title="No mapping jobs yet">
            Map two panel files in entity resolution (New job in the left rail) and wait for both to finish. They then
            appear here.
          </Notice>
        ) : (
          <div className="grid gap-6 md:grid-cols-2">
            {(["a", "b"] as const).map((side) => (
              <JobSide
                key={side}
                side={side}
                jobs={jobs}
                value={side === "a" ? jobA : jobB}
                other={side === "a" ? jobB : jobA}
                label={side === "a" ? aLabel : bLabel}
                onPick={(id) => pick(side, id)}
                onLabel={(v) => { setError(null); (side === "a" ? setALabel : setBLabel)(v); }}
              />
            ))}
          </div>
        )}
        <div className="flex items-start gap-3">
          <Switch id="harm-link-by-name" checked={linkByName} onCheckedChange={setLinkByName} data-testid="switch-link-by-name" />
          <Label htmlFor="harm-link-by-name" className="cursor-pointer font-normal">
            Link by name too
            <span className="block text-xs text-neutral-500">
              {linkByName
                ? "On: resolved rows whose names match are also linked, even when they resolved to different nodes."
                : "Off (default): rows are linked by node and identifier only."}
            </span>
          </Label>
        </div>
      </CardContent>
      <CardFooter className="flex flex-col items-stretch gap-3 border-t bg-neutral-50 py-4">
        {error && (
          <Notice tone="danger" title="The run was not started" testId="submit-error">{error}</Notice>
        )}
        <div className="flex items-center justify-end gap-3">
          {blocker && <p className="text-sm text-neutral-500">{blocker}</p>}
          <Button
            size="lg"
            disabled={!!blocker || submit.isPending}
            onClick={() => submit.mutate({ data: { jobA, jobB, aLabel: aLabel.trim(), bLabel: bLabel.trim(), linkByName } })}
            data-testid="btn-start-from-jobs"
          >
            {submit.isPending ? <><Loader2 className="animate-spin" /> Harmonizing...</> : <><Play /> Harmonize finished jobs</>}
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}

function JobSide({
  side,
  jobs,
  value,
  other,
  label,
  onPick,
  onLabel,
}: {
  side: "a" | "b";
  jobs: Array<{ jobId: string; displayName?: string | null; status: string; total: number; createdAt: number }>;
  value: string;
  other: string;
  label: string;
  onPick: (id: string) => void;
  onLabel: (v: string) => void;
}) {
  const detail = useGetJob(value, { query: { queryKey: getGetJobQueryKey(value), enabled: !!value, staleTime: 5 * 60 * 1000 } });
  const otherDetail = useGetJob(other, { query: { queryKey: getGetJobQueryKey(other), enabled: !!other, staleTime: 5 * 60 * 1000 } });
  const entityOf = (d: typeof detail) => d.data?.config?.entityType ?? null;
  const mine = entityOf(detail);
  const theirs = entityOf(otherDetail);
  const letter = side.toUpperCase();
  const labelOk = !label || isValidLabel(label.trim());
  return (
    <div className="space-y-3" data-testid={`job-side-${side}`}>
      <div className="space-y-1.5">
        <Label htmlFor={`job-${side}`}>Job {letter}</Label>
        <Select value={value} onValueChange={onPick}>
          <SelectTrigger id={`job-${side}`} data-testid={`select-job-${side}`}>
            <SelectValue placeholder="Choose a finished mapping job" />
          </SelectTrigger>
          <SelectContent>
            {jobs.map((j) => {
              const finished = j.status === "complete";
              return (
                <SelectItem key={j.jobId} value={j.jobId} disabled={!finished || j.jobId === other}>
                  {j.displayName || `Job ${j.jobId.slice(0, 8)}`}
                  <span className="ml-2 text-xs text-neutral-500">
                    {finished ? `${j.total.toLocaleString()} names` : `${j.status}, not finished`}
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        {value && (
          <p className="text-xs text-neutral-500" data-testid={`job-${side}-entity`}>
            Entity type: {detail.isLoading ? "loading..." : detail.isError ? "could not be read" : mine ?? "not recorded"}
          </p>
        )}
        {mine && theirs && mine !== theirs && side === "b" && (
          <p className="text-xs text-warning">These two jobs map different entity types; the run will be refused.</p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`job-label-${side}`}>Label for job {letter}</Label>
        <Input
          id={`job-label-${side}`}
          value={label}
          onChange={(e) => onLabel(e.target.value)}
          placeholder={`e.g. cohort_${side}`}
          className="font-mono"
          aria-invalid={!labelOk}
          data-testid={`input-job-label-${side}`}
        />
        {!labelOk && <p className="text-xs text-warning">Letters, digits, '.', '-' and '_' only.</p>}
      </div>
    </div>
  );
}
