import { useState, useCallback } from "react";
import { useLocation } from "wouter";
import { useDropzone } from "react-dropzone";
import * as XLSX from "xlsx";
import Papa from "papaparse";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useStartMappingBatch, MappingConfigAnnotationMode } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Loader2, UploadCloud, FileType, CheckCircle2, ArrowLeft } from "lucide-react";

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

export type ConfidenceFilter = "all" | "high_medium" | "high";

export default function UploadPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [selectedColumn, setSelectedColumn] = useState<string>("");
  const [parsedRows, setParsedRows] = useState<Record<string, string>[]>([]);
  const [annotationMode, setAnnotationMode] = useState<MappingConfigAnnotationMode>("missing");
  const [selectedOntologies, setSelectedOntologies] = useState<Set<OntologyKey>>(new Set(ALL_ONTOLOGIES));
  const [confidenceFilter, setConfidenceFilter] = useState<ConfidenceFilter>("all");

  const startMapping = useStartMappingBatch();

  const extractNamesFromRows = useCallback((rows: Record<string, string>[], column: string) => {
    return [...new Set(
      rows
        .map(row => row[column])
        .filter(val => val !== null && val !== undefined && String(val).trim() !== "")
        .map(val => String(val).trim())
    )];
  }, []);

  const extractedNames = selectedColumn && parsedRows.length > 0
    ? extractNamesFromRows(parsedRows, selectedColumn)
    : [];

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
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
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

    startMapping.mutate(
      {
        data: {
          names: extractedNames,
          config: { annotationMode }
        }
      },
      {
        onSuccess: (data) => {
          setLocation(`/job/${data.job_id}?ontologies=${ontologiesParam}&confidence=${confidenceFilter}`);
        },
        onError: () => {
          toast({ title: "Failed to start mapping", description: "Unknown error", variant: "destructive" });
        }
      }
    );
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b border-border bg-card px-6 py-3 flex items-center gap-4 sticky top-0 z-10">
        <Button variant="ghost" size="icon" onClick={() => setLocation("/")} data-testid="btn-back-home">
          <ArrowLeft className="w-4 h-4" />
        </Button>
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
                      Found {extractedNames.length.toLocaleString()} unique names
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
                  <Label>Target Ontologies <span className="text-muted-foreground font-normal text-xs ml-1">(controls which identifier columns appear in results)</span></Label>
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
