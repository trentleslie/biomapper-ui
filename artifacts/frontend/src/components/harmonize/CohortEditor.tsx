import { useId } from "react";
import { useDropzone } from "react-dropzone";
import { FileText, Loader2, Trash2, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { CohortDraft, HeaderColumn } from "@/lib/harmonize";
import { headerColumns, headerProblems, plural } from "@/lib/harmonize";

const NONE = "__none__";

export interface InspectState {
  status: "idle" | "loading" | "ok" | "error";
  /** The header as the file has it, blanks and repeats included. */
  header: string[];
  /** The columns that can be chosen: named, and for a repeated name only its last column. */
  columns: string[];
  rowCount: number | null;
  error: string | null;
}

export interface CohortSlot {
  id: string;
  file: File | null;
  inspect: InspectState;
  draft: CohortDraft;
  labelTouched: boolean;
}

export const EMPTY_INSPECT: InspectState = { status: "idle", header: [], columns: [], rowCount: null, error: null };

/** An inspect answer as the editor keeps it: the raw header, and the columns that can be chosen. */
export function inspectOk(header: string[], rowCount: number): InspectState {
  const columns = headerColumns(header).filter((c) => c.usable).map((c) => c.name);
  return { status: "ok", header, columns, rowCount, error: null };
}

/** A file chooser that also takes a dropped file. Any file type is passed on; the server says what it accepts. */
export function FilePick({
  label,
  multiple = false,
  onFiles,
  compact = false,
  testId,
}: {
  label: string;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
  compact?: boolean;
  testId?: string;
}) {
  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop: (files) => files.length && onFiles(files),
    multiple,
    noClick: true,
    noKeyboard: true,
  });
  return (
    <div
      {...getRootProps()}
      data-testid={testId}
      className={cn(
        "flex flex-wrap items-center gap-3 rounded border border-dashed px-4",
        compact ? "py-2" : "py-4",
        isDragActive ? "border-ph-navy bg-neutral-100" : "border-neutral-300 bg-neutral-50",
      )}
    >
      <input {...getInputProps({ accept: ".tsv,.csv,.txt" })} aria-label={label} />
      <UploadCloud aria-hidden className="h-5 w-5 text-neutral-400" />
      <span className="text-sm text-neutral-600">
        {isDragActive ? "Drop to add" : multiple ? "Drop .tsv or .csv files here, or" : "Drop a .tsv or .csv file here, or"}
      </span>
      <Button type="button" variant="secondary" size="sm" onClick={open}>
        {label}
      </Button>
    </div>
  );
}

function ColumnSelect({
  id,
  value,
  columns,
  unusable = [],
  onChange,
  optional,
  placeholder,
  ariaLabel,
}: {
  id: string;
  value: string;
  columns: string[];
  unusable?: HeaderColumn[];
  onChange: (v: string) => void;
  optional?: boolean;
  placeholder: string;
  ariaLabel: string;
}) {
  const missing = value && !columns.includes(value);
  return (
    <Select value={value ? value : optional ? NONE : undefined} onValueChange={(v) => onChange(v === NONE ? "" : v)}>
      <SelectTrigger id={id} aria-label={ariaLabel} className={cn(missing && "border-warning")}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {optional && <SelectItem value={NONE}>No key column</SelectItem>}
        {columns.map((c) => (
          <SelectItem key={c} value={c}>
            {c}
          </SelectItem>
        ))}
        {unusable.map((c) => (
          <SelectItem key={`unusable-${c.index}`} value={`__unusable_${c.index}__`} disabled>
            {c.display}: {c.reason}
          </SelectItem>
        ))}
        {missing && (
          <SelectItem value={value} disabled>
            {value} (not in this file)
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}

/**
 * One cohort: its file (checked by the server on pick: row count and header), its label, its name and key
 * columns, and which columns hold which identifier vocabulary. Every column list comes from the file's own
 * header.
 */
export function CohortEditor({
  title,
  slot,
  vocabSuggestions,
  onFile,
  onChange,
  onRemove,
  compact = false,
}: {
  title: string;
  slot: CohortSlot;
  vocabSuggestions: string[];
  onFile: (file: File) => void;
  onChange: (draft: CohortDraft, labelTouched?: boolean) => void;
  onRemove?: () => void;
  compact?: boolean;
}) {
  const uid = useId();
  const { inspect, draft } = slot;
  const columns = inspect.columns;
  const unusable = headerColumns(inspect.header).filter((c) => !c.usable);
  const problems = headerProblems(inspect.header);
  const identifierColumns = columns.filter((c) => c !== draft.nameColumn);
  const missingVocabColumns = Object.keys(draft.vocabByColumn).filter((c) => draft.vocabByColumn[c] && !columns.includes(c));
  const listId = `${uid}-vocabs`;

  return (
    <section
      aria-label={`${title}${draft.label ? `: ${draft.label}` : ""}`}
      className="rounded border border-neutral-200 bg-white"
      data-testid="cohort-editor"
    >
      <div className="flex items-center justify-between gap-3 border-b border-neutral-200 px-4 py-2.5">
        <h3 className="text-sm font-semibold text-neutral-900">{title}</h3>
        {onRemove && (
          <Button type="button" variant="ghost" size="sm" onClick={onRemove} aria-label={`Remove ${title}`}>
            <Trash2 aria-hidden />
            Remove
          </Button>
        )}
      </div>
      <div className={cn("space-y-4 p-4", compact && "space-y-3")}>
        {slot.file ? (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2">
              <FileText aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-neutral-400" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-neutral-900" title={slot.file.name}>
                  {slot.file.name}
                </p>
                {inspect.status === "loading" && (
                  <p className="flex items-center gap-1.5 text-xs text-neutral-500" role="status">
                    <Loader2 aria-hidden className="h-3 w-3 animate-spin motion-reduce:animate-none" /> Reading the file header
                  </p>
                )}
                {inspect.status === "ok" && (
                  <p className="text-xs text-neutral-500" data-testid="inspect-summary">
                    {plural(inspect.rowCount ?? 0, "row")}, {plural(inspect.header.length, "column")}:{" "}
                    {headerColumns(inspect.header).map((c) => c.display).join(", ")}
                  </p>
                )}
                {inspect.status === "ok" && problems.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-xs text-warning" data-testid="header-problems">
                    {problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <FilePick label={`Replace file for ${title}`} onFiles={(f) => onFile(f[0])} compact />
          </div>
        ) : (
          <FilePick label={`Choose file for ${title}`} onFiles={(f) => onFile(f[0])} />
        )}
        {inspect.status === "error" && inspect.error && (
          <p role="alert" className="rounded border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger">
            {inspect.error}
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-label`}>Label</Label>
            <Input
              id={`${uid}-label`}
              aria-label={`Label for ${title}`}
              value={draft.label}
              placeholder="e.g. arivale_2024"
              onChange={(e) => onChange({ ...draft, label: e.target.value }, true)}
            />
            <p className="text-xs text-neutral-500">Letters, digits, dot, dash and underscore.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-name`}>Name column</Label>
            <ColumnSelect
              id={`${uid}-name`}
              ariaLabel={`Name column for ${title}`}
              value={draft.nameColumn}
              columns={columns}
              unusable={unusable}
              placeholder={columns.length ? "Pick a column" : "Choose a file first"}
              onChange={(v) => {
                const vocab = { ...draft.vocabByColumn };
                delete vocab[v];
                onChange({ ...draft, nameColumn: v, vocabByColumn: vocab });
              }}
            />
            {draft.nameColumn && !columns.includes(draft.nameColumn) && columns.length > 0 && (
              <p className="text-xs text-warning">Column '{draft.nameColumn}' is not in this file.</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-key`}>Key column (optional)</Label>
            <ColumnSelect
              id={`${uid}-key`}
              ariaLabel={`Key column for ${title}`}
              value={draft.keyColumn}
              columns={columns}
              unusable={unusable}
              optional
              placeholder="No key column"
              onChange={(v) => onChange({ ...draft, keyColumn: v })}
            />
            <p className="text-xs text-neutral-500">Without one, rows are keyed by their name.</p>
          </div>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-neutral-700">Identifier columns</legend>
          <p className="text-xs text-neutral-500">
            Type the vocabulary each identifier column holds (for example HMDB). Leave it blank when the column holds
            no identifier. Two columns can hold the same vocabulary.
          </p>
          {identifierColumns.length === 0 ? (
            <p className="text-sm text-neutral-500">
              {columns.length ? "No other columns in this file." : "The file's columns appear here once you choose it."}
            </p>
          ) : (
            <div className="scroll-visible max-h-56 rounded border border-neutral-200" data-testid="vocab-columns">
              <datalist id={listId}>
                {vocabSuggestions.map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
              <table className="w-full text-sm">
                <caption className="sr-only">Vocabulary per column for {title}</caption>
                <thead className="sticky top-0 z-10 bg-neutral-50">
                  <tr className="border-b border-neutral-200">
                    <th scope="col" className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-neutral-500">Column</th>
                    <th scope="col" className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-neutral-500">Vocabulary</th>
                  </tr>
                </thead>
                <tbody>
                  {[...identifierColumns, ...missingVocabColumns].map((c) => (
                    <tr key={c} className="border-b border-neutral-100 last:border-b-0">
                      <td className="px-3 py-1.5 font-mono text-xs text-neutral-900">
                        {c}
                        {!columns.includes(c) && <span className="ml-2 font-sans text-warning">(not in this file)</span>}
                      </td>
                      <td className="px-3 py-1.5">
                        <Input
                          list={listId}
                          className="h-8"
                          aria-label={`Vocabulary in column ${c} of ${title}`}
                          placeholder="Not an identifier"
                          value={draft.vocabByColumn[c] ?? ""}
                          onChange={(e) => onChange({ ...draft, vocabByColumn: { ...draft.vocabByColumn, [c]: e.target.value } })}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </fieldset>
      </div>
    </section>
  );
}
