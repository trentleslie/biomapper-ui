import { useState, useCallback, useMemo, useEffect } from "react";
import { useLocation } from "wouter";
import { useDropzone } from "react-dropzone";
import * as XLSX from "xlsx";
import Papa from "papaparse";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  useStartMappingBatch,
  useListEntityTypes,
  useListAnnotators,
  getListEntityTypesQueryKey,
  getListAnnotatorsQueryKey,
  MappingConfigAnnotationMode,
  MappingConfigHints,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Loader2, UploadCloud, FileType, CheckCircle2 } from "lucide-react";

// Display vocabularies — these are the keys the backend currently emits in
// MappingResultItem.identifiers. The set is fixed by services/mapper.py.
const ALL_ONTOLOGIES = ["hmdb", "chebi", "pubchem", "refmet", "lipidmaps", "kegg", "umls", "mesh", "unii", "chembl"] as const;
type OntologyKey = typeof ALL_ONTOLOGIES[number];

const ONTOLOGY_LABELS: Record<OntologyKey, string> = {
  hmdb: "HMDB",
  chebi: "ChEBI",
  pubchem: "PubChem",
  refmet: "RefMet",
  lipidmaps: "LIPIDMAPS",
  kegg: "KEGG",
  umls: "UMLS",
  mesh: "MeSH",
  unii: "UNII",
  chembl: "ChEMBL",
};

// Per-entity-type display defaults. Backend always returns the same 10 keys,
// but we surface the most relevant subset by default.
const ENTITY_TYPE_DEFAULT_VOCABS: Record<string, OntologyKey[]> = {
  "biolink:SmallMolecule": ["hmdb", "chebi", "refmet", "lipidmaps", "pubchem"],
  "biolink:Drug":          ["chembl", "unii", "mesh", "chebi", "pubchem"],
  "biolink:ChemicalEntity":["chebi", "pubchem", "hmdb", "lipidmaps", "kegg"],
};
const FALLBACK_VOCABS: OntologyKey[] = [...ALL_ONTOLOGIES];

// Common ID column heuristics — map column-name fragments to a CURIE prefix.
// Used to auto-suggest a vocabulary when a user picks a "Provided ID column".
const COLUMN_PREFIX_HINTS: Array<[RegExp, string]> = [
  [/hmdb/i,                     "HMDB"],
  [/chebi/i,                    "CHEBI"],
  [/pubchem|cid/i,              "PUBCHEM.COMPOUND"],
  [/refmet/i,                   "refmet_id"],
  [/lipid\s*maps?|lmid|lm[_-]?id/i, "LIPIDMAPS"],
  [/kegg/i,                     "KEGG.COMPOUND"],
  [/umls/i,                     "UMLS"],
  [/mesh/i,                     "MESH"],
  [/unii/i,                     "UNII"],
  [/chembl/i,                   "ChEMBL"],
  [/inchikey/i,                 "INCHIKEY"],
  [/^cas$|cas[_-]?(number|no|rn)/i, "CAS"],
];

function inferPrefix(columnName: string): string | null {
  for (const [re, prefix] of COLUMN_PREFIX_HINTS) {
    if (re.test(columnName)) return prefix;
  }
  return null;
}

export type ConfidenceFilter = "all" | "high_medium" | "high";

export default function UploadPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [selectedColumn, setSelectedColumn] = useState<string>("");
  const [parsedRows, setParsedRows] = useState<Record<string, string>[]>([]);
  const [annotationMode, setAnnotationMode] = useState<MappingConfigAnnotationMode>("missing");
  const [entityType, setEntityType] = useState<string>("biolink:SmallMolecule");
  const [selectedAnnotators, setSelectedAnnotators] = useState<Set<string>>(new Set());
  const [selectedOntologies, setSelectedOntologies] = useState<Set<OntologyKey>>(new Set(ENTITY_TYPE_DEFAULT_VOCABS["biolink:SmallMolecule"]));
  const [hintColumns, setHintColumns] = useState<Set<string>>(new Set());
  const [confidenceFilter, setConfidenceFilter] = useState<ConfidenceFilter>("all");

  // Discovery — long staleTime since these are slow-moving reference data.
  const entityTypesQuery = useListEntityTypes({
    query: { queryKey: getListEntityTypesQueryKey(), staleTime: 60 * 60 * 1000, retry: 1 },
  });
  const annotatorsQuery = useListAnnotators({
    query: { queryKey: getListAnnotatorsQueryKey(), staleTime: 60 * 60 * 1000, retry: 1 },
  });

  const startMapping = useStartMappingBatch();

  // When entity type changes, swap the default vocab display preset.
  useEffect(() => {
    const preset = ENTITY_TYPE_DEFAULT_VOCABS[entityType] ?? FALLBACK_VOCABS;
    setSelectedOntologies(new Set(preset));
  }, [entityType]);

  // If the user picks a name column that was previously selected as a hint
  // column, drop it from hintColumns so it can't silently produce hints
  // (the column would also disappear from the rendered hint list).
  useEffect(() => {
    if (!selectedColumn) return;
    setHintColumns(prev => {
      if (!prev.has(selectedColumn)) return prev;
      const next = new Set(prev);
      next.delete(selectedColumn);
      return next;
    });
  }, [selectedColumn]);

  const extractNamesFromRows = useCallback((rows: Record<string, string>[], column: string) => {
    return [...new Set(
      rows
        .map(row => row[column])
        .filter(val => val !== null && val !== undefined && String(val).trim() !== "")
        .map(val => String(val).trim())
    )];
  }, []);

  const rawTotalRows = selectedColumn && parsedRows.length > 0
    ? parsedRows.filter(row => {
        const val = row[selectedColumn];
        return val !== null && val !== undefined && String(val).trim() !== "";
      }).length
    : 0;

  const extractedNames = useMemo(
    () => (selectedColumn && parsedRows.length > 0 ? extractNamesFromRows(parsedRows, selectedColumn) : []),
    [selectedColumn, parsedRows, extractNamesFromRows]
  );

  // Map of selected hint column -> resolved CURIE prefix (skipping any that
  // we can't auto-detect). The user sees which columns are mappable.
  const hintColumnPrefixMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const col of hintColumns) {
      // Defensive: never derive hints from the active name column even if
      // state cleanup hasn't yet propagated (race during column switch).
      if (col === selectedColumn) continue;
      const prefix = inferPrefix(col);
      if (prefix) m[col] = prefix;
    }
    return m;
  }, [hintColumns, selectedColumn]);

  // Build hints payload: { name -> { PREFIX -> id } } for rows where at least
  // one selected ID column has a value.
  const hintsPayload = useMemo<MappingConfigHints | undefined>(() => {
    if (!selectedColumn || hintColumns.size === 0) return undefined;
    const result: MappingConfigHints = {};
    for (const row of parsedRows) {
      const name = row[selectedColumn];
      if (name === null || name === undefined || String(name).trim() === "") continue;
      const trimmedName = String(name).trim();
      const perRow: Record<string, string | string[]> = {};
      for (const [col, prefix] of Object.entries(hintColumnPrefixMap)) {
        const val = row[col];
        if (val === null || val === undefined || String(val).trim() === "") continue;
        perRow[prefix] = String(val).trim();
      }
      if (Object.keys(perRow).length > 0) {
        // Last-wins on duplicate names is fine for hints (idempotent merge).
        result[trimmedName] = { ...(result[trimmedName] || {}), ...perRow };
      }
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }, [parsedRows, selectedColumn, hintColumns, hintColumnPrefixMap]);

  const processRows = useCallback((rows: Record<string, string>[]) => {
    if (rows.length === 0) return;
    const cols = Object.keys(rows[0]);
    setColumns(cols);
    setParsedRows(rows);
    const likelyNameCol = cols.find(f =>
      f.toLowerCase().includes('name') ||
      f.toLowerCase().includes('compound') ||
      f.toLowerCase().includes('metabolite')
    ) || cols[0];
    setSelectedColumn(likelyNameCol);
    setHintColumns(new Set());
  }, []);

  const parseFile = useCallback((uploadedFile: File) => {
    const reader = new FileReader();

    if (uploadedFile.name.endsWith('.csv') || uploadedFile.name.endsWith('.tsv')) {
      reader.onload = (e) => {
        const text = e.target?.result as string;
        Papa.parse<Record<string, string>>(text, {
          header: true,
          skipEmptyLines: true,
          complete: (results) => {
            processRows(results.data);
          },
          error: (err: Error) => {
            toast({ title: "Error parsing file", description: err.message, variant: "destructive" });
          }
        });
      };
      reader.readAsText(uploadedFile);
    } else if (uploadedFile.name.endsWith('.xlsx') || uploadedFile.name.endsWith('.xls')) {
      reader.onload = (e) => {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const json = XLSX.utils.sheet_to_json(worksheet) as Record<string, string>[];
        processRows(json);
      };
      reader.readAsArrayBuffer(uploadedFile);
    }
  }, [processRows, toast]);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length === 0) return;
    const uploadedFile = acceptedFiles[0];
    setFile(uploadedFile);
    parseFile(uploadedFile);
  }, [parseFile]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'text/csv': ['.csv'],
      'text/tab-separated-values': ['.tsv'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
      'application/vnd.ms-excel': ['.xls']
    },
    maxFiles: 1
  });

  const toggleOntology = (key: OntologyKey) => {
    setSelectedOntologies(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const toggleAnnotator = (slug: string) => {
    setSelectedAnnotators(prev => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug); else next.add(slug);
      return next;
    });
  };

  const toggleHintColumn = (col: string) => {
    setHintColumns(prev => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col); else next.add(col);
      return next;
    });
  };

  const handleSubmit = () => {
    if (extractedNames.length === 0) {
      toast({ title: "No names found", description: "Please select a column with valid data", variant: "destructive" });
      return;
    }

    if (extractedNames.length > 10000) {
      toast({ title: "Too many names", description: "Maximum 10,000 names allowed per job", variant: "destructive" });
      return;
    }

    const ontologiesParam = Array.from(selectedOntologies).join(",");
    const annotatorsList = Array.from(selectedAnnotators);

    startMapping.mutate(
      {
        data: {
          names: extractedNames,
          config: {
            annotationMode,
            entityType,
            // null/undefined means "use all annotators" on the backend.
            annotators: annotatorsList.length > 0 ? annotatorsList : null,
            ...(hintsPayload ? { hints: hintsPayload } : {}),
          },
        }
      },
      {
        onSuccess: (data) => {
          const params = new URLSearchParams({
            ontologies: ontologiesParam,
            confidence: confidenceFilter,
            totalRows: String(rawTotalRows),
            entityType,
          });
          setLocation(`/job/${data.job_id}?${params.toString()}`);
        },
        onError: () => {
          toast({ title: "Failed to start mapping", description: "Unknown error", variant: "destructive" });
        }
      }
    );
  };

  const entityTypes = entityTypesQuery.data || [];
  const annotators = annotatorsQuery.data || [];
  // Available hint columns = all columns except the selected name column.
  const availableHintColumns = columns.filter(c => c !== selectedColumn);
  const hintRowCount = hintsPayload ? Object.keys(hintsPayload).length : 0;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b border-border bg-card px-6 py-3 flex items-center gap-4 sticky top-0 z-10">
        <span className="font-semibold text-foreground tracking-tight">PhenomeHealth Linker</span>
      </header>

      <div className="max-w-3xl w-full mx-auto mt-10 px-6 pb-16">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-foreground tracking-tight mb-2">New Mapping Job</h1>
          <p className="text-muted-foreground">Upload a dataset to link compound names to biological ontologies.</p>
        </div>

        <div className="grid gap-6">
          <Card>
            <CardHeader>
              <CardTitle>1. Upload Dataset</CardTitle>
              <CardDescription>Drag and drop a CSV, TSV, or Excel file containing compound names.</CardDescription>
            </CardHeader>
            <CardContent>
              <div
                {...getRootProps()}
                className={`border-2 border-dashed rounded-lg p-10 text-center cursor-pointer transition-colors ${
                  isDragActive ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
                }`}
                data-testid="dropzone-upload"
              >
                <input {...getInputProps()} />

                {file ? (
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-12 h-12 rounded-full bg-primary/10 text-primary flex items-center justify-center">
                      <FileType className="w-6 h-6" />
                    </div>
                    <div>
                      <p className="font-medium text-foreground">{file.name}</p>
                      <p className="text-sm text-muted-foreground">{(file.size / 1024).toFixed(1)} KB</p>
                    </div>
                    <Button variant="outline" size="sm" onClick={(e) => {
                      e.stopPropagation();
                      setFile(null);
                      setColumns([]);
                      setParsedRows([]);
                      setSelectedColumn("");
                      setHintColumns(new Set());
                    }} className="mt-2" data-testid="btn-remove-file">
                      Remove File
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-12 h-12 rounded-full bg-muted text-muted-foreground flex items-center justify-center mb-2">
                      <UploadCloud className="w-6 h-6" />
                    </div>
                    <p className="text-foreground font-medium">Click or drag file to this area to upload</p>
                    <p className="text-sm text-muted-foreground">Supported formats: .csv, .tsv, .xlsx</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {file && columns.length > 0 && (
            <Card className="animate-in fade-in slide-in-from-bottom-4">
              <CardHeader>
                <CardTitle>2. Configure Mapping</CardTitle>
                <CardDescription>Select the name column, mapping settings, and display preferences.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-3">
                  <Label htmlFor="column-select">Name Column</Label>
                  <Select value={selectedColumn} onValueChange={setSelectedColumn}>
                    <SelectTrigger id="column-select" data-testid="select-name-col">
                      <SelectValue placeholder="Select column..." />
                    </SelectTrigger>
                    <SelectContent>
                      {columns.map(col => (
                        <SelectItem key={col} value={col}>{col}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {extractedNames.length > 0 && (
                    <p className="text-sm text-muted-foreground flex items-center gap-1.5 mt-2">
                      <CheckCircle2 className="w-4 h-4 text-primary" />
                      {rawTotalRows.toLocaleString()} rows → {extractedNames.length.toLocaleString()} unique names (after dedup)
                    </p>
                  )}
                </div>

                {availableHintColumns.length > 0 && (
                  <div className="space-y-3">
                    <Label>
                      Provided ID Columns
                      <span className="text-muted-foreground font-normal text-xs ml-1">
                        (optional — pre-fill known cross-references as hints to BioMapper)
                      </span>
                    </Label>
                    <div className="grid grid-cols-2 gap-2" data-testid="hint-column-checkboxes">
                      {availableHintColumns.map(col => {
                        const prefix = inferPrefix(col);
                        const isSelected = hintColumns.has(col);
                        return (
                          <div key={col} className="flex items-center gap-2">
                            <Checkbox
                              id={`hint-col-${col}`}
                              checked={isSelected}
                              onCheckedChange={() => toggleHintColumn(col)}
                              disabled={!prefix}
                              data-testid={`checkbox-hint-${col}`}
                            />
                            <Label
                              htmlFor={`hint-col-${col}`}
                              className={`font-normal cursor-pointer text-sm ${!prefix ? "text-muted-foreground/60" : ""}`}
                              title={prefix ? `Will be sent as ${prefix} hints` : "No vocabulary recognized in column name"}
                            >
                              {col}
                              {prefix && (
                                <span className="ml-1.5 text-xs text-muted-foreground">→ {prefix}</span>
                              )}
                            </Label>
                          </div>
                        );
                      })}
                    </div>
                    {hintColumns.size > 0 && (
                      <p className="text-xs text-muted-foreground">
                        {hintRowCount > 0
                          ? `Hints will be sent for ${hintRowCount.toLocaleString()} unique name${hintRowCount === 1 ? "" : "s"}.`
                          : "No usable hint values found in selected columns."}
                      </p>
                    )}
                  </div>
                )}

                <div className="space-y-3">
                  <Label htmlFor="entity-type">
                    Entity Type
                    <span className="text-muted-foreground font-normal text-xs ml-1">
                      (Biolink class — controls which annotators are valid)
                    </span>
                  </Label>
                  <Select value={entityType} onValueChange={setEntityType} disabled={entityTypesQuery.isLoading}>
                    <SelectTrigger id="entity-type" data-testid="select-entity-type">
                      <SelectValue placeholder={entityTypesQuery.isLoading ? "Loading..." : "Select entity type"} />
                    </SelectTrigger>
                    <SelectContent>
                      {entityTypes.length === 0 && !entityTypesQuery.isLoading && (
                        <SelectItem value="biolink:SmallMolecule">biolink:SmallMolecule (default)</SelectItem>
                      )}
                      {entityTypes.map(et => (
                        <SelectItem key={et.type} value={et.type}>
                          {et.type}
                          {et.aliases && et.aliases.length > 0 && (
                            <span className="text-xs text-muted-foreground ml-2">({et.aliases.join(", ")})</span>
                          )}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {entityTypesQuery.isError && (
                    <p className="text-xs text-amber-600">
                      Couldn't load entity types — defaulting to biolink:SmallMolecule.
                    </p>
                  )}
                </div>

                <div className="space-y-3">
                  <Label htmlFor="annotation-mode">Annotation Mode</Label>
                  <Select value={annotationMode} onValueChange={(v) => setAnnotationMode(v as MappingConfigAnnotationMode)}>
                    <SelectTrigger id="annotation-mode" data-testid="select-annotation-mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="missing">Missing (Only add annotations if not present)</SelectItem>
                      <SelectItem value="all">All (Force all annotators to run)</SelectItem>
                      <SelectItem value="none">None (Skip annotation phase)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-3">
                  <Label>
                    Annotators
                    <span className="text-muted-foreground font-normal text-xs ml-1">
                      (leave all unchecked to use the BioMapper default set)
                    </span>
                  </Label>
                  {annotatorsQuery.isLoading ? (
                    <p className="text-xs text-muted-foreground">Loading annotators…</p>
                  ) : annotatorsQuery.isError ? (
                    <p className="text-xs text-amber-600">Couldn't load annotators — leaving unspecified (server defaults).</p>
                  ) : (
                    <div className="grid grid-cols-1 gap-2" data-testid="annotator-checkboxes">
                      {annotators.map(a => (
                        <div key={a.slug} className="flex items-center gap-2">
                          <Checkbox
                            id={`annotator-${a.slug}`}
                            checked={selectedAnnotators.has(a.slug)}
                            onCheckedChange={() => toggleAnnotator(a.slug)}
                            data-testid={`checkbox-annotator-${a.slug}`}
                          />
                          <Label htmlFor={`annotator-${a.slug}`} className="font-normal cursor-pointer text-sm">
                            <span className="font-mono text-xs">{a.slug}</span>
                            <span className="text-muted-foreground ml-2">{a.name}</span>
                          </Label>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-3">
                  <Label>Display Vocabularies <span className="text-muted-foreground font-normal text-xs ml-1">(controls which identifier columns appear in results)</span></Label>
                  <div className="grid grid-cols-2 gap-2" data-testid="ontology-checkboxes">
                    {ALL_ONTOLOGIES.map(key => (
                      <div key={key} className="flex items-center gap-2">
                        <Checkbox
                          id={`ontology-${key}`}
                          checked={selectedOntologies.has(key)}
                          onCheckedChange={() => toggleOntology(key)}
                          data-testid={`checkbox-ontology-${key}`}
                        />
                        <Label htmlFor={`ontology-${key}`} className="font-normal cursor-pointer">
                          {ONTOLOGY_LABELS[key]}
                        </Label>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-3">
                  <Label htmlFor="confidence-filter">Confidence Filter <span className="text-muted-foreground font-normal text-xs ml-1">(filters which results appear in the dashboard table)</span></Label>
                  <Select value={confidenceFilter} onValueChange={(v) => setConfidenceFilter(v as ConfidenceFilter)}>
                    <SelectTrigger id="confidence-filter" data-testid="select-confidence-filter">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Show All Results</SelectItem>
                      <SelectItem value="high_medium">High + Medium Only</SelectItem>
                      <SelectItem value="high">High Confidence Only</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
              <CardFooter className="bg-muted/50 border-t flex justify-end py-4">
                <Button
                  size="lg"
                  onClick={handleSubmit}
                  disabled={extractedNames.length === 0 || startMapping.isPending}
                  data-testid="btn-start-mapping"
                >
                  {startMapping.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Starting Job...
                    </>
                  ) : (
                    "Start Mapping"
                  )}
                </Button>
              </CardFooter>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
