import { useState, useCallback, useMemo, useEffect } from "react";
import { useLocation } from "wouter";
import { useDropzone } from "react-dropzone";
import * as XLSX from "xlsx";
import Papa from "papaparse";
import { saveOriginalData } from "@/lib/original-data-store";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  useStartMappingBatch,
  useListEntityTypes,
  useListAnnotators,
  useListVocabularies,
  getListEntityTypesQueryKey,
  getListAnnotatorsQueryKey,
  getListVocabulariesQueryKey,
  MappingConfigAnnotationMode,
  MappingConfigHints,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Loader2, UploadCloud, FileType, CheckCircle2 } from "lucide-react";
import { FieldTooltip } from "@/components/field-tooltip";
import { EnvToggle } from "@/components/EnvToggle";
import { useEnv } from "@/contexts/env-context";
import { ToastAction } from "@/components/ui/toast";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

// Default selected vocabularies per entity type. These act as a UX preset;
// the full list of selectable vocabularies is fetched from /discovery/vocabularies.
// Keys are CURIE prefixes as returned by BioMapper discovery (uppercase).
const ENTITY_TYPE_DEFAULT_PREFIXES: Record<string, string[]> = {
  "biolink:SmallMolecule":  ["HMDB", "CHEBI", "REFMET", "LIPIDMAPS", "PUBCHEM.COMPOUND"],
  "biolink:Drug":           ["CHEMBL", "UNII", "MESH", "CHEBI", "PUBCHEM.COMPOUND"],
  "biolink:ChemicalEntity": ["CHEBI", "PUBCHEM.COMPOUND", "HMDB", "LIPIDMAPS", "KEGG.COMPOUND"],
  "biolink:Protein":        ["UNIPROT", "NCBIGENE", "ENSEMBL"],
  "biolink:Gene":           ["NCBIGENE", "ENSEMBL", "HGNC"],
  "biolink:Pathway":        ["REACT", "KEGG.PATHWAY", "WIKIPATHWAYS"],
  "biolink:Disease":        ["MONDO", "DOID", "MESH"],
  "biolink:PhenotypicFeature": ["HP", "MESH"],
  "biolink:ClinicalFinding":   ["LOINC", "SNOMEDCT"],
};

// Heuristic suggestion for "Provided ID Columns" — maps column-name fragments
// to a CURIE prefix. Used for auto-default only; the user can still select
// any column (the column name uppercased is sent as the prefix when no
// heuristic match is found).
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
  [/uniprot/i,                  "UNIPROT"],
  [/ensembl/i,                  "ENSEMBL"],
  [/ncbi[_-]?gene|entrez/i,     "NCBIGENE"],
  [/hgnc/i,                     "HGNC"],
];

// Value-based prefix detection — used when column-name heuristic fails.
// Order matters: more specific patterns first, generic (pure numeric) last.
const VALUE_PREFIX_PATTERNS: Array<[RegExp, string]> = [
  [/^HMDB\d+$/i,           "HMDB"],
  [/^CHEBI[:\s]?\d+$/i,    "CHEBI"],
  [/^C\d{5}$/,             "KEGG.COMPOUND"],
  [/^LM[A-Z]{2}\d+$/i,    "LIPIDMAPS"],
  [/^RM[:\s]?\d+$/i,       "refmet_id"],
  [/^\d+$/,                "PUBCHEM.COMPOUND"],
];

const ANNOTATOR_DESCRIPTION_FALLBACKS: Record<string, string> = {
  "kestrel-hybrid-search": "Combines text and semantic vector search for comprehensive matching",
  "kestrel-text-search": "Exact and fuzzy text matching against entity name databases",
  "kestrel-vector-search": "Semantic similarity matching using vector embeddings",
  "metabolomics-workbench": "Lookup against the Metabolomics Workbench reference database",
};

function inferPrefix(columnName: string, sampleValues?: string[]): string {
  // 1. Try value-based detection first when sample values are provided.
  if (sampleValues && sampleValues.length > 0) {
    const counts = new Map<string, number>();
    for (const val of sampleValues) {
      for (const [re, prefix] of VALUE_PREFIX_PATTERNS) {
        if (re.test(val)) {
          counts.set(prefix, (counts.get(prefix) || 0) + 1);
          break; // first matching pattern wins per value
        }
      }
    }
    if (counts.size > 0) {
      // Pick the prefix with the most matches.
      let bestPrefix = "";
      let bestCount = 0;
      for (const [prefix, count] of counts) {
        if (count > bestCount) {
          bestPrefix = prefix;
          bestCount = count;
        }
      }
      // Must exceed 50% of non-empty samples to be confident.
      if (bestCount > sampleValues.length / 2) {
        return bestPrefix;
      }
    }
  }

  // 2. Fall back to column-name regex heuristic.
  for (const [re, prefix] of COLUMN_PREFIX_HINTS) {
    if (re.test(columnName)) return prefix;
  }
  // 3. Fallback: use the column name itself (uppercased, normalized).
  return columnName.trim().toUpperCase().replace(/\s+/g, "_");
}

export type ConfidenceFilter = "all" | "high_medium" | "high";

export default function UploadPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { env, setEnv } = useEnv();
  const [mode, setMode] = useState<'link' | 'benchmark'>('link');
  const [file, setFile] = useState<File | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [selectedColumn, setSelectedColumn] = useState<string>("");
  const [parsedRows, setParsedRows] = useState<Record<string, string>[]>([]);
  const [annotationMode, setAnnotationMode] = useState<MappingConfigAnnotationMode>("missing");
  const [entityType, setEntityType] = useState<string>("biolink:SmallMolecule");
  const [selectedAnnotators, setSelectedAnnotators] = useState<Set<string>>(new Set());
  const [selectedVocabPrefixes, setSelectedVocabPrefixes] = useState<Set<string>>(
    new Set(ENTITY_TYPE_DEFAULT_PREFIXES["biolink:SmallMolecule"])
  );
  const [showAllVocabs, setShowAllVocabs] = useState(false);
  const [vocabSearch, setVocabSearch] = useState("");
  const [hintColumns, setHintColumns] = useState<Set<string>>(new Set());
  const [prefixOverrides, setPrefixOverrides] = useState<Record<string, string>>({});
  const [confidenceFilter, setConfidenceFilter] = useState<ConfidenceFilter>("all");

  // Discovery — long staleTime since these are slow-moving reference data.
  const entityTypesQuery = useListEntityTypes({
    query: { queryKey: getListEntityTypesQueryKey(), staleTime: 60 * 60 * 1000, retry: 1 },
  });
  const annotatorsQuery = useListAnnotators({
    query: { queryKey: getListAnnotatorsQueryKey(), staleTime: 60 * 60 * 1000, retry: 1 },
  });
  const vocabulariesQuery = useListVocabularies({
    query: { queryKey: getListVocabulariesQueryKey(), staleTime: 60 * 60 * 1000, retry: 1 },
  });

  const startMapping = useStartMappingBatch();

  // When entity type changes, swap the default vocab selection preset.
  useEffect(() => {
    const preset = ENTITY_TYPE_DEFAULT_PREFIXES[entityType] ?? [];
    setSelectedVocabPrefixes(new Set(preset));
  }, [entityType]);

  // Reconcile hint columns when name column changes (drop collisions).
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

  // Per-hint-column → CURIE prefix (column name is the auto-suggested key).
  const hintColumnPrefixMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const col of hintColumns) {
      // Defensive: never derive hints from the active name column.
      if (col === selectedColumn) continue;
      // User override takes priority.
      if (prefixOverrides[col]) {
        m[col] = prefixOverrides[col];
        continue;
      }
      // Sample up to 20 non-empty values from parsedRows for value-based detection.
      const sampleValues: string[] = [];
      for (const row of parsedRows) {
        if (sampleValues.length >= 20) break;
        const val = row[col];
        if (val !== null && val !== undefined && String(val).trim() !== "") {
          sampleValues.push(String(val).trim());
        }
      }
      m[col] = inferPrefix(col, sampleValues);
    }
    return m;
  }, [hintColumns, selectedColumn, prefixOverrides, parsedRows]);

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
        if (!result[trimmedName]) {
          result[trimmedName] = perRow;
        } else {
          // Accumulate: if a key already exists, make it an array.
          const existing = result[trimmedName] as Record<string, string | string[]>;
          for (const [key, val] of Object.entries(perRow)) {
            if (key in existing) {
              const prev = existing[key];
              if (Array.isArray(prev)) {
                if (!prev.includes(val as string)) prev.push(val as string);
              } else if (prev !== val) {
                existing[key] = [prev as string, val as string];
              }
            } else {
              existing[key] = val;
            }
          }
        }
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
    setPrefixOverrides({});
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

  const toggleVocab = (prefix: string) => {
    setSelectedVocabPrefixes(prev => {
      const next = new Set(prev);
      if (next.has(prefix)) next.delete(prefix); else next.add(prefix);
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

    // URL ontologies param uses lowercase prefix (matches the case backend uses
    // in MappingResultItem.identifiers keys).
    const ontologiesParam = Array.from(selectedVocabPrefixes).map(p => p.toLowerCase()).join(",");
    const annotatorsList = Array.from(selectedAnnotators);

    const hintColumnsPayload: Record<string, string> = {};
    for (const [col, prefix] of Object.entries(hintColumnPrefixMap)) {
      hintColumnsPayload[prefix] = col;
    }

    startMapping.mutate(
      {
        data: {
          names: extractedNames,
          config: {
            annotationMode,
            entityType,
            annotators: annotatorsList.length > 0 ? annotatorsList : null,
            ...(hintsPayload ? { hints: hintsPayload } : {}),
            ...(Object.keys(hintColumnsPayload).length > 0 ? { hintColumns: hintColumnsPayload } : {}),
          },
        }
      },
      {
        onSuccess: async (data) => {
          // Persist original rows to IndexedDB before navigating so downloads
          // can join results back to the full uploaded dataset.
          await saveOriginalData(data.job_id, { parsedRows, selectedColumn, columns });
          const params = new URLSearchParams({
            ontologies: ontologiesParam,
            confidence: confidenceFilter,
            totalRows: String(rawTotalRows),
            entityType,
          });
          setLocation(`/job/${data.job_id}?${params.toString()}`);
        },
        onError: (error: unknown) => {
          const apiError = error as { status?: number; data?: { env?: string; detail?: string } } | undefined;
          const hasDevEnvField = apiError?.data?.env === "dev";
          const isDevStatusCode = apiError?.status === 502 || apiError?.status === 503;
          const isDevEnvError = isDevStatusCode && (hasDevEnvField || env === "dev");
          if (isDevEnvError) {
            toast({
              variant: "destructive",
              title: "Dev API is unavailable",
              description: apiError?.data?.detail ?? "Could not reach the dev biomapper2 backend",
              duration: Infinity,
              action: (
                <ToastAction altText="Switch to Production" onClick={() => setEnv("production")}>
                  Switch to Production
                </ToastAction>
              ),
            });
          } else {
            toast({ title: "Failed to start mapping", description: "Unknown error", variant: "destructive" });
          }
        }
      }
    );
  };

  const entityTypes = entityTypesQuery.data || [];
  const annotators = annotatorsQuery.data || [];
  const allVocabularies = vocabulariesQuery.data || [];

  // Vocab list shown by default = entity-type preset + currently selected.
  // "Show all" reveals the full discovery list (310 entries), with optional search.
  const presetPrefixes = ENTITY_TYPE_DEFAULT_PREFIXES[entityType] ?? [];
  const featuredPrefixSet = new Set<string>([...presetPrefixes, ...selectedVocabPrefixes]);
  const visibleVocabs = useMemo(() => {
    if (!showAllVocabs) {
      // Show featured set, sorted with selected first.
      return allVocabularies
        .filter(v => featuredPrefixSet.has(v.prefix))
        .sort((a, b) => a.prefix.localeCompare(b.prefix));
    }
    const q = vocabSearch.trim().toLowerCase();
    return allVocabularies
      .filter(v => !q || v.prefix.toLowerCase().includes(q) || (v.aliases || []).some(a => a.toLowerCase().includes(q)))
      .sort((a, b) => a.prefix.localeCompare(b.prefix))
      .slice(0, 200); // safety cap to avoid rendering 310 rows when search is empty
  }, [allVocabularies, showAllVocabs, vocabSearch, featuredPrefixSet]);

  const availableHintColumns = columns.filter(c => c !== selectedColumn);
  const hintRowCount = hintsPayload ? Object.keys(hintsPayload).length : 0;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b border-border bg-card px-6 py-3 flex items-center justify-between sticky top-0 z-10">
        <span className="font-semibold text-foreground tracking-tight">PhenomeHealth Linker</span>
        <EnvToggle />
      </header>

      <div className="max-w-3xl w-full mx-auto mt-10 px-6 pb-16">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-foreground tracking-tight mb-2">New Mapping Job</h1>
          <p className="text-muted-foreground">Upload a dataset to link entity names to biological vocabularies.</p>
        </div>

        <div className="flex items-center gap-2 mb-6">
          <Tabs value={mode} onValueChange={(v) => setMode(v as 'link' | 'benchmark')}>
            <TabsList>
              <TabsTrigger value="link">Entity Linking</TabsTrigger>
              <TabsTrigger value="benchmark">Benchmark</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="ml-auto">
            <FieldTooltip label="Help: Mode">
              Entity Linking maps your compound names to standardized identifiers. Benchmark mode (coming soon) lets you evaluate mapping accuracy against known-correct data.
            </FieldTooltip>
          </div>
        </div>

        {mode === 'benchmark' ? (
          <Card>
            <CardHeader className="text-center">
              <CardTitle>Benchmark Mode</CardTitle>
              <CardDescription className="text-lg">Coming Soon</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-center text-muted-foreground">
                {"Evaluate BioMapper's accuracy by comparing results against your known-correct identifiers. Upload a dataset with answer columns to measure precision, recall, and confidence calibration."}
              </p>
            </CardContent>
          </Card>
        ) : (
        <div className="grid gap-6">
          <Card>
            <CardHeader>
              <CardTitle>1. Upload Dataset</CardTitle>
              <CardDescription>Drag and drop a CSV, TSV, or Excel file containing entity names.</CardDescription>
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
                      setPrefixOverrides({});
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
                  <Label htmlFor="column-select">Name Column <FieldTooltip label="Help: Name Column">Select the column containing entity names to map (e.g., compound names, metabolite names). Each unique name will be sent to BioMapper for identification.</FieldTooltip></Label>
                  <Select value={selectedColumn} onValueChange={setSelectedColumn}>
                    <SelectTrigger id="column-select" data-testid="select-name-col">
                      <SelectValue placeholder="Select column..." />
                    </SelectTrigger>
                    <SelectContent className="max-h-72 overflow-y-auto">
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
                      <FieldTooltip label="Help: Provided ID Columns">Columns with known identifiers (e.g., HMDB IDs, CHEBI IDs) that help BioMapper confirm or improve matches. These act as hints, not constraints.</FieldTooltip>
                      <span className="text-muted-foreground font-normal text-xs ml-1">
                        (optional — pre-fill known cross-references as hints to BioMapper)
                      </span>
                    </Label>
                    <div className="grid grid-cols-2 gap-2" data-testid="hint-column-checkboxes">
                      {availableHintColumns.map(col => {
                        const isSelected = hintColumns.has(col);
                        // For unchecked columns, sample values to show value-based prefix preview.
                        const sampleVals = parsedRows.slice(0, 20).map(r => r[col]).filter(v => v != null && String(v).trim() !== "").map(v => String(v).trim());
                        const resolvedPrefix = hintColumnPrefixMap[col] || inferPrefix(col, sampleVals);
                        return (
                          <div key={col} className="flex items-center gap-2">
                            <Checkbox
                              id={`hint-col-${col}`}
                              checked={isSelected}
                              onCheckedChange={() => toggleHintColumn(col)}
                              data-testid={`checkbox-hint-${col}`}
                            />
                            {isSelected ? (
                              <div className="flex items-center gap-1.5 min-w-0">
                                <Label
                                  htmlFor={`hint-col-${col}`}
                                  className="font-normal cursor-pointer text-sm shrink-0"
                                >
                                  {col} →
                                </Label>
                                <Input
                                  className="h-6 text-xs px-1.5 py-0 w-36 font-mono"
                                  value={prefixOverrides[col] ?? resolvedPrefix}
                                  onChange={(e) => {
                                    setPrefixOverrides(prev => ({
                                      ...prev,
                                      [col]: e.target.value,
                                    }));
                                  }}
                                  onBlur={(e) => {
                                    if (e.target.value.trim() === "") {
                                      setPrefixOverrides(prev => {
                                        const next = { ...prev };
                                        delete next[col];
                                        return next;
                                      });
                                    }
                                  }}
                                  data-testid={`input-prefix-${col}`}
                                />
                              </div>
                            ) : (
                              <Label
                                htmlFor={`hint-col-${col}`}
                                className="font-normal cursor-pointer text-sm"
                                title={`Will be sent as ${resolvedPrefix} hints`}
                              >
                                {col}
                                <span className="ml-1.5 text-xs text-muted-foreground">→ {resolvedPrefix}</span>
                              </Label>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {(() => {
                      // Check for prefix collisions among checked hint columns.
                      const prefixCounts = new Map<string, string[]>();
                      for (const [col, prefix] of Object.entries(hintColumnPrefixMap)) {
                        const cols = prefixCounts.get(prefix) || [];
                        cols.push(col);
                        prefixCounts.set(prefix, cols);
                      }
                      const collisions = [...prefixCounts.entries()].filter(([, cols]) => cols.length > 1);
                      if (collisions.length > 0) {
                        return (
                          <p className="text-xs text-amber-600">
                            Warning: columns {collisions.map(([prefix, cols]) => `[${cols.join(", ")}] both resolve to "${prefix}"`).join("; ")}. Consider overriding one prefix to avoid conflicts.
                          </p>
                        );
                      }
                      return null;
                    })()}
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
                    <FieldTooltip label="Help: Entity Type">The Biolink ontology class for your entities. This determines which vocabularies and identification strategies are used. SmallMolecule is correct for most metabolomics data.</FieldTooltip>
                    <span className="text-muted-foreground font-normal text-xs ml-1">
                      (Biolink class — drives default vocabulary preset)
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
                  <Label htmlFor="annotation-mode">Annotation Mode <FieldTooltip label="Help: Annotation Mode">Controls how BioMapper handles identifier annotation. 'Missing' only annotates entities without existing IDs. 'All' re-annotates everything. 'None' skips annotation entirely.</FieldTooltip></Label>
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
                    <FieldTooltip label="Help: Annotators">Select specific annotators to use, or leave all unchecked to use the full default set. Each annotator uses a different strategy (text search, vector similarity, etc.) to find matches.</FieldTooltip>
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
                      {annotators.map(a => {
                        const desc = a.description || ANNOTATOR_DESCRIPTION_FALLBACKS[a.slug] || "(no description available)";
                        return (
                          <div key={a.slug} className="flex items-start gap-2">
                            <Checkbox
                              id={`annotator-${a.slug}`}
                              checked={selectedAnnotators.has(a.slug)}
                              onCheckedChange={() => toggleAnnotator(a.slug)}
                              data-testid={`checkbox-annotator-${a.slug}`}
                              className="mt-0.5"
                            />
                            <Label htmlFor={`annotator-${a.slug}`} className="font-normal cursor-pointer text-sm">
                              <span className="font-mono text-xs">{a.slug}</span>
                              <span className="text-muted-foreground ml-2">{a.name}</span>
                              <span className="block text-xs text-muted-foreground mt-0.5">{desc}</span>
                            </Label>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label>
                      Display Vocabularies
                      <FieldTooltip label="Help: Display Vocabularies">Choose which identifier vocabularies appear as columns in the results table. Presets are based on entity type; switch to 'Show all' to search across 300+ vocabularies.</FieldTooltip>
                      <span className="text-muted-foreground font-normal text-xs ml-1">
                        (controls which identifier columns appear in results)
                      </span>
                    </Label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowAllVocabs(v => !v)}
                      disabled={vocabulariesQuery.isLoading || vocabulariesQuery.isError}
                      data-testid="btn-toggle-all-vocabs"
                    >
                      {showAllVocabs ? "Show preset only" : `Show all (${allVocabularies.length})`}
                    </Button>
                  </div>

                  {showAllVocabs && (
                    <Input
                      placeholder="Search vocabularies (e.g. UNIPROT, ENSEMBL, REACT)…"
                      value={vocabSearch}
                      onChange={(e) => setVocabSearch(e.target.value)}
                      data-testid="input-vocab-search"
                    />
                  )}

                  {vocabulariesQuery.isLoading ? (
                    <p className="text-xs text-muted-foreground">Loading vocabularies…</p>
                  ) : vocabulariesQuery.isError ? (
                    <p className="text-xs text-amber-600">
                      Couldn't load vocabularies — display columns will be derived from results.
                    </p>
                  ) : visibleVocabs.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {showAllVocabs ? "No vocabularies match your search." : "No preset for this entity type — use \"Show all\" to pick vocabularies."}
                    </p>
                  ) : (
                    <div
                      className={`grid grid-cols-2 gap-2 ${showAllVocabs ? "max-h-64 overflow-y-auto pr-2" : ""}`}
                      data-testid="vocab-checkboxes"
                    >
                      {visibleVocabs.map(v => (
                        <div key={v.prefix} className="flex items-center gap-2">
                          <Checkbox
                            id={`vocab-${v.prefix}`}
                            checked={selectedVocabPrefixes.has(v.prefix)}
                            onCheckedChange={() => toggleVocab(v.prefix)}
                            data-testid={`checkbox-vocab-${v.prefix}`}
                          />
                          <Label htmlFor={`vocab-${v.prefix}`} className="font-normal cursor-pointer text-sm font-mono">
                            {v.prefix}
                          </Label>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-3">
                  <Label htmlFor="confidence-filter">Confidence Filter <FieldTooltip label="Help: Confidence Filter">Filter which results appear in the dashboard. 'High + Medium' hides uncertain matches. 'High Only' shows only the most confident identifications.</FieldTooltip> <span className="text-muted-foreground font-normal text-xs ml-1">(filters which results appear in the dashboard table)</span></Label>
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
        )}
      </div>
    </div>
  );
}
