import { useState, useMemo, useCallback, useEffect } from "react";
import { useLocation, useParams, useSearch } from "wouter";
import { useUser, useClerk } from "@clerk/react";
import { useMappingStream } from "@/hooks/use-mapping-stream";
import { loadOriginalData, type OriginalData } from "@/lib/original-data-store";
import { useGetMappingResult, getGetMappingResultQueryKey, JobResult } from "@workspace/api-client-react";
import { SankeyChart } from "@/components/SankeyChart";
import { EnvToggle } from "@/components/EnvToggle";
import { EquivalentIds } from "@/components/EquivalentIds";
import { useEnv } from "@/contexts/env-context";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { MappingSummary, MappingResult } from "@/types/mapping";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis,
  Tooltip as RechartsTooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Download, AlertCircle, Loader2, ArrowLeft, LogOut,
  ChevronDown, ChevronRight, ChevronUp, Search, Flag, X,
} from "lucide-react";

const TIER_COLORS: Record<string, string> = {
  high: '#22c55e',
  medium: '#f59e0b',
  low: '#f97316',
  unknown: '#9ca3af',
};

type SortField = "name" | "confidenceTier" | "confidenceScore";
type SortDir = "asc" | "desc";
type ConfidenceFilter = "all" | "high_medium" | "high";

const PAGE_SIZE = 25;

export default function DashboardPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const searchString = useSearch();
  const params = new URLSearchParams(searchString);
  const [, setLocation] = useLocation();
  const { signOut } = useClerk();
  const { user } = useUser();

  // Vocabularies the user picked on the upload page (lowercased CURIE prefixes).
  // Empty set => fall back to "show every vocabulary actually present in results".
  const initialOntologies = params.get("ontologies")
    ? new Set(params.get("ontologies")!.split(",").map(v => v.toLowerCase()).filter(Boolean))
    : new Set<string>();
  const initialConfidence = (params.get("confidence") as ConfidenceFilter) || "all";
  // Total rows from the uploaded file (before dedup); passed from upload page via URL param
  const urlTotalRows = params.get("totalRows") ? parseInt(params.get("totalRows")!, 10) : null;

  const [visibleOntologies] = useState<Set<string>>(initialOntologies);
  const [confidenceFilter, setConfidenceFilter] = useState<ConfidenceFilter>(initialConfidence);
  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [page, setPage] = useState(1);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [flaggedNames, setFlaggedNames] = useState<Set<string>>(new Set());
  const [dismissedNames, setDismissedNames] = useState<Set<string>>(new Set());

  const { env, setEnv } = useEnv();
  const { toast } = useToast();

  const { jobState, done, error: streamError } = useMappingStream(jobId || "");
  const { data: finalResult, isLoading } = useGetMappingResult(jobId || "", {
    query: {
      enabled: done || (!jobState && !!jobId),
      queryKey: getGetMappingResultQueryKey(jobId || ""),
    }
  });

  useEffect(() => {
    if (streamError?.isDevEnvError && env === "dev") {
      toast({
        variant: "destructive",
        title: "Dev API is unavailable",
        description: streamError.message,
        duration: Infinity,
        action: (
          <ToastAction altText="Switch to Production" onClick={() => setEnv("production")}>
            Switch to Production
          </ToastAction>
        ),
      });
    }
  }, [streamError, env, toast, setEnv]);

  // Prefer live SSE state while streaming; fall back to the final fetch result once done.
  // Never treat a still-loading or 202-style intermediate response as an error.
  const job = jobState ?? (done && finalResult && "status" in finalResult ? finalResult : null);
  // Only surface an error if the SSE stream is done (or never started) AND we still have no valid job data.
  const isError = !isLoading && !jobState && job && "detail" in job;
  const jobData = job && !("detail" in job) ? job as JobResult : null;
  const results = (jobData?.results || []) as MappingResult[];

  const summary = useMemo<MappingSummary | null>(() => {
    if (!jobData || results.length === 0) return null;

    const uniqueNames = new Set(results.map(r => r.name)).size;
    const resolved = results.filter(r => r.resolved).length;
    const high = results.filter(r => r.confidenceTier === "high").length;
    const medium = results.filter(r => r.confidenceTier === "medium").length;
    const low = results.filter(r => r.confidenceTier === "low").length;
    const unknownCount = results.filter(r => !r.confidenceTier || r.confidenceTier === "unknown").length;

    const vocabCoverage: Record<string, number> = {};
    results.forEach(r => {
      if (r.identifiers) {
        Object.entries(r.identifiers).forEach(([vocab, ids]) => {
          if (ids && ids.length > 0) {
            const key = vocab.toLowerCase();
            vocabCoverage[key] = (vocabCoverage[key] || 0) + 1;
          }
        });
      }
    });

    return {
      // totalRows = original file row count (including duplicates) passed from upload page,
      // or falls back to uniqueNames if URL param not available (e.g., direct navigation)
      totalRows: urlTotalRows ?? uniqueNames,
      uniqueNames: Math.max(uniqueNames, 1),
      resolved,
      resolvedRate: uniqueNames > 0 ? resolved / uniqueNames : 0,
      highQualityRate: uniqueNames > 0 ? (high + medium) / uniqueNames : 0,
      confidenceTierDistribution: { high, medium, low, unknown: unknownCount },
      vocabularyCoverage: vocabCoverage,
    };
  }, [jobData, results, urlTotalRows]);

  const filteredResults = useMemo(() => {
    let filtered = results;

    if (confidenceFilter === "high_medium") {
      filtered = filtered.filter(r => r.confidenceTier === "high" || r.confidenceTier === "medium");
    } else if (confidenceFilter === "high") {
      filtered = filtered.filter(r => r.confidenceTier === "high");
    }

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      filtered = filtered.filter(r => r.name?.toLowerCase().includes(q));
    }

    return [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sortField === "name") {
        cmp = (a.name || "").localeCompare(b.name || "");
      } else if (sortField === "confidenceTier") {
        const order = { high: 0, medium: 1, low: 2, unknown: 3 };
        const aOrder = order[a.confidenceTier as keyof typeof order] ?? 4;
        const bOrder = order[b.confidenceTier as keyof typeof order] ?? 4;
        cmp = aOrder - bOrder;
      } else if (sortField === "confidenceScore") {
        cmp = (b.confidenceScore ?? -1) - (a.confidenceScore ?? -1);
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [results, confidenceFilter, search, sortField, sortDir]);

  const totalPages = Math.max(1, Math.ceil(filteredResults.length / PAGE_SIZE));
  const pagedResults = filteredResults.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const needsReview = results.filter(r =>
    (r.needsReview || !r.resolved || r.confidenceTier === "unknown" || r.confidenceTier === "low") &&
    !dismissedNames.has(r.name)
  );

  const flagReviewItem = (name: string) => {
    setFlaggedNames(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const dismissReviewItem = (name: string) => {
    setDismissedNames(prev => new Set([...prev, name]));
  };

  const toggleSort = useCallback((field: SortField) => {
    if (sortField === field) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("asc");
    }
    setPage(1);
  }, [sortField]);

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return null;
    return sortDir === "asc" ? <ChevronUp className="w-3 h-3 ml-1 inline" /> : <ChevronDown className="w-3 h-3 ml-1 inline" />;
  };

  const handleDownloadJSON = async () => {
    if (!jobData || !summary) return;
    const originalData = jobId ? await loadOriginalData(jobId) : undefined;
    const payload: Record<string, unknown> = { summary, results };
    if (originalData) {
      payload.originalRows = originalData.parsedRows;
    }
    const data = JSON.stringify(payload, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mapping-results-${jobId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Shared helper: build biomapper column names and per-result row values.
  const buildBiomapperColumns = () => {
    const allVocabs = new Set<string>();
    results.forEach(r => {
      if (r.identifiers) Object.keys(r.identifiers).forEach(k => allVocabs.add(k));
    });
    const vocabCols = Array.from(allVocabs)
      .map(v => v.toLowerCase())
      .filter(v => visibleOntologies.size === 0 || visibleOntologies.has(v))
      .sort();

    const allEquivPrefixes = new Set<string>();
    results.forEach(r => {
      if (r.kgEquivalentIds) Object.keys(r.kgEquivalentIds).forEach(k => allEquivPrefixes.add(k));
    });
    const equivCols = Array.from(allEquivPrefixes)
      .filter(p => visibleOntologies.size === 0 || visibleOntologies.has(p.toLowerCase()))
      .sort();

    return { vocabCols, equivCols };
  };

  const biomapperRowValues = (r: MappingResult, vocabCols: string[], equivCols: string[]) => {
    const row: string[] = [
      r.resolved ? "true" : "false",
      r.primaryCurie || "",
      r.confidenceTier || "",
      r.confidenceScore?.toString() || "",
      r.needsReview ? "true" : "false",
    ];
    const idMap: Record<string, string[] | undefined> = {};
    if (r.identifiers) {
      for (const [k, val] of Object.entries(r.identifiers)) {
        idMap[k.toLowerCase()] = val as string[] | undefined;
      }
    }
    vocabCols.forEach(v => {
      row.push(idMap[v]?.join("|") || "");
    });
    equivCols.forEach(p => {
      row.push(r.kgEquivalentIds?.[p]?.join("|") || "");
    });
    return row;
  };

  // Deduplicate biomapper column names against original columns.
  const deduplicateColName = (name: string, existingNames: Set<string>): string => {
    if (!existingNames.has(name)) return name;
    let candidate = `${name}_2`;
    let i = 3;
    while (existingNames.has(candidate)) {
      candidate = `${name}_${i++}`;
    }
    return candidate;
  };

  const buildEnrichedDownload = async (
    delimiter: "\t" | ",",
    escape?: (val: string) => string,
  ): Promise<{ content: string; hasOriginalData: boolean }> => {
    const esc = escape ?? ((v: string) => v);
    const { vocabCols, equivCols } = buildBiomapperColumns();

    // Try loading original data from IndexedDB.
    const originalData = jobId ? await loadOriginalData(jobId) : undefined;

    if (originalData) {
      // --- Enriched path: original columns + _biomapper columns ---
      const { parsedRows, selectedColumn, columns } = originalData;
      const originalColSet = new Set(columns);

      // Build biomapper column headers with _biomapper suffix.
      const coreHeaders = ["resolved_biomapper", "primary_curie_biomapper", "confidence_tier_biomapper", "confidence_score_biomapper", "needs_review_biomapper"];
      const vocabHeaders = vocabCols.map(v => `${v}_biomapper`);
      const equivHeaders = equivCols.map(p => `equiv_${p}_biomapper`);
      const allBiomapperHeaders = [...coreHeaders, ...vocabHeaders, ...equivHeaders];

      // Deduplicate biomapper headers against original column names.
      const dedupedBiomapperHeaders = allBiomapperHeaders.map(h => deduplicateColName(h, originalColSet));

      const headers = [...columns, ...dedupedBiomapperHeaders];

      // Build result lookup by trimmed name.
      const resultMap = new Map<string, MappingResult>();
      for (const r of results) {
        if (r.name) resultMap.set(r.name.trim(), r);
      }

      // One row per original row, joined by name.
      const rows = parsedRows.map(row => {
        const name = row[selectedColumn];
        const trimmedName = name != null ? String(name).trim() : "";
        const result = resultMap.get(trimmedName);

        const originalValues = columns.map(col => esc(row[col] ?? ""));
        const bmValues = result
          ? biomapperRowValues(result, vocabCols, equivCols).map(esc)
          : allBiomapperHeaders.map(() => "");

        return [...originalValues, ...bmValues].join(delimiter);
      });

      const content = [headers.map(esc).join(delimiter), ...rows].join("\n");
      return { content, hasOriginalData: true };
    }

    // --- Fallback: current results-only format (backward-compatible) ---
    const providedIdCols = new Set<string>();
    results.forEach(r => {
      if (r.providedIds) Object.keys(r.providedIds).forEach(k => providedIdCols.add(k));
    });
    const sortedProvidedIdCols = Array.from(providedIdCols).sort();
    const hasProvidedIds = sortedProvidedIdCols.length > 0;

    const headers = [
      "Original Name", "Resolved", "Primary Curie", "Confidence Tier", "Confidence Score", "Needs Review",
      ...sortedProvidedIdCols,
      ...vocabCols.map(v => hasProvidedIds ? `${v}_biomapper` : v),
      ...equivCols.map(p => hasProvidedIds ? `equiv_${p}_biomapper` : `equiv_${p}`),
    ];
    const rows = results.map(r => {
      const row = [
        r.name,
        r.resolved ? "true" : "false",
        r.primaryCurie || "",
        r.confidenceTier || "",
        r.confidenceScore?.toString() || "",
        r.needsReview ? "true" : "false",
      ];
      sortedProvidedIdCols.forEach(col => {
        const val = r.providedIds?.[col];
        row.push(Array.isArray(val) ? val.join("|") : (val || ""));
      });
      const bmRow = biomapperRowValues(r, vocabCols, equivCols);
      // bmRow already has resolved..needsReview + vocab + equiv, but fallback row
      // already has those core values, so just append vocab + equiv from offset 5.
      const idMap: Record<string, string[] | undefined> = {};
      if (r.identifiers) {
        for (const [k, val] of Object.entries(r.identifiers)) {
          idMap[k.toLowerCase()] = val as string[] | undefined;
        }
      }
      vocabCols.forEach(v => {
        row.push(idMap[v]?.join("|") || "");
      });
      equivCols.forEach(p => {
        row.push(r.kgEquivalentIds?.[p]?.join("|") || "");
      });
      return row.map(esc).join(delimiter);
    });

    const content = [headers.map(esc).join(delimiter), ...rows].join("\n");
    return { content, hasOriginalData: false };
  };

  const handleDownloadTSV = async () => {
    if (!results || results.length === 0) return;
    const { content } = await buildEnrichedDownload("\t");
    const blob = new Blob([content], { type: "text/tab-separated-values" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mapping-results-${jobId}.tsv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadCSV = async () => {
    if (!results || results.length === 0) return;
    const csvEscape = (val: string) => {
      if (val.includes(",") || val.includes('"') || val.includes("\n")) {
        return `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    };
    const { content } = await buildEnrichedDownload(",", csvEscape);
    const blob = new Blob([content], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mapping-results-${jobId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Display columns are derived from whatever vocabularies actually appear in
  // the results (lowercased). If the upload page passed an `ontologies` filter,
  // restrict to the intersection; otherwise show every vocabulary present.
  // NOTE: hooks must run before any early return to keep call order stable.
  const presentVocabKeys = useMemo(() => {
    const s = new Set<string>();
    for (const r of results) {
      if (!r.identifiers) continue;
      for (const [k, v] of Object.entries(r.identifiers)) {
        if (v && v.length > 0) s.add(k.toLowerCase());
      }
    }
    return s;
  }, [results]);
  const visibleVocabCols = useMemo(() => {
    const allowed = visibleOntologies.size > 0
      ? Array.from(presentVocabKeys).filter(v => visibleOntologies.has(v))
      : Array.from(presentVocabKeys);
    return allowed.sort();
  }, [presentVocabKeys, visibleOntologies]);

  // Collect unique provided ID column names for the results table.
  const providedIdColsForTable = useMemo(() => {
    const cols = new Set<string>();
    for (const r of results) {
      if (r.providedIds) {
        Object.keys(r.providedIds).forEach(k => cols.add(k));
      }
    }
    return Array.from(cols).sort();
  }, [results]);

  const handleDownloadMarkdown = () => {
    if (!summary) return;
    const { confidenceTierDistribution: cd, vocabularyCoverage: vc } = summary;
    const unresolved = summary.uniqueNames - summary.resolved;
    const vocabRows = Object.entries(vc)
      .sort(([, a], [, b]) => b - a)
      .map(([vocab, count]) => `| ${vocab.toUpperCase()} | ${count} |`)
      .join("\n");

    const unresolvedNames = results
      .filter(r => !r.resolved)
      .map(r => `- ${r.name}`)
      .join("\n") || "_None_";

    const lines = [
      `# Entity Linking Report`,
      ``,
      `**Job ID:** \`${jobId}\`  `,
      `**Status:** ${jobData?.status || "unknown"}`,
      ``,
      `## Summary`,
      ``,
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Total Rows | ${summary.totalRows.toLocaleString()} |`,
      `| Unique Names | ${summary.uniqueNames.toLocaleString()} |`,
      `| Resolved | ${summary.resolved.toLocaleString()} (${(summary.resolvedRate * 100).toFixed(1)}%) |`,
      `| Unresolved | ${unresolved.toLocaleString()} |`,
      `| High Quality (high + medium) | ${((cd.high + cd.medium) / summary.uniqueNames * 100).toFixed(1)}% |`,
      ``,
      `## Confidence Tier Distribution`,
      ``,
      `| Tier | Count | % of Unique |`,
      `|------|-------|-------------|`,
      `| High | ${cd.high} | ${(cd.high / summary.uniqueNames * 100).toFixed(1)}% |`,
      `| Medium | ${cd.medium} | ${(cd.medium / summary.uniqueNames * 100).toFixed(1)}% |`,
      `| Low | ${cd.low} | ${(cd.low / summary.uniqueNames * 100).toFixed(1)}% |`,
      `| Unknown | ${cd.unknown} | ${(cd.unknown / summary.uniqueNames * 100).toFixed(1)}% |`,
      ``,
      `## Vocabulary Coverage`,
      ``,
      `| Vocabulary | Hits |`,
      `|-----------|------|`,
      vocabRows,
      ``,
      `## Unresolved Names Analysis`,
      ``,
      `${unresolved} name(s) could not be resolved:`,
      ``,
      unresolvedNames,
    ];

    const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mapping-report-${jobId}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (isError) {
    return (
      <div className="min-h-screen p-8 bg-background flex items-center justify-center">
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle className="text-destructive flex items-center gap-2">
              <AlertCircle className="w-5 h-5" /> Error Loading Job
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">The job could not be loaded or an error occurred.</p>
            <Button className="mt-4" onClick={() => setLocation("/upload")}>Return to Upload</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!jobData && isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-muted-foreground">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <p>Loading job details...</p>
        </div>
      </div>
    );
  }

  if (!jobData) return null;

  const isProcessing = jobData.status === "pending" || jobData.status === "processing";
  const progressPct = jobData.total > 0 ? Math.round((jobData.completed / jobData.total) * 100) : 0;
  const pieData = summary ? [
    { name: 'High', value: summary.confidenceTierDistribution.high, fill: TIER_COLORS.high },
    { name: 'Medium', value: summary.confidenceTierDistribution.medium, fill: TIER_COLORS.medium },
    { name: 'Low', value: summary.confidenceTierDistribution.low, fill: TIER_COLORS.low },
    { name: 'Unknown', value: summary.confidenceTierDistribution.unknown, fill: TIER_COLORS.unknown },
  ].filter(d => d.value > 0) : [];

  const barData = summary ? Object.entries(summary.vocabularyCoverage)
    .map(([name, value]) => ({ name: name.toUpperCase(), value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10) : [];

  // Per-row case-insensitive identifier accessor.
  const lookupIds = (row: MappingResult, key: string): string[] | undefined => {
    if (!row.identifiers) return undefined;
    const direct = (row.identifiers as Record<string, string[] | undefined>)[key];
    if (direct) return direct;
    for (const [k, v] of Object.entries(row.identifiers)) {
      if (k.toLowerCase() === key) return v as string[] | undefined;
    }
    return undefined;
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card px-6 py-3 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => setLocation("/upload")} data-testid="btn-back-upload">
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div>
            <h1 className="font-semibold tracking-tight text-foreground flex items-center gap-2">
              Job: <span className="font-mono text-sm font-normal text-muted-foreground">{jobId}</span>
              {isProcessing && <Badge variant="secondary" className="ml-2 animate-pulse">Processing</Badge>}
              {jobData.status === "complete" && <Badge className="bg-green-600 ml-2">Complete</Badge>}
              {jobData.status === "error" && <Badge variant="destructive" className="ml-2">Failed</Badge>}
            </h1>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <EnvToggle />
          <span className="text-sm text-muted-foreground hidden sm:block">{user?.primaryEmailAddress?.emailAddress}</span>
          <Button variant="outline" size="sm" onClick={() => signOut()} data-testid="btn-sign-out">
            <LogOut className="w-4 h-4 mr-2" /> Sign Out
          </Button>
        </div>
      </header>

      <main className="p-6 max-w-7xl mx-auto space-y-6">

        {isProcessing && (
          <Card>
            <CardContent className="pt-6">
              <div className="flex justify-between text-sm mb-2 font-medium">
                <span>Processing: {jobData.completed.toLocaleString()} / {jobData.total.toLocaleString()}</span>
                <span>{progressPct}%</span>
              </div>
              <Progress value={progressPct} className="h-2" />
            </CardContent>
          </Card>
        )}

        {summary && (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card>
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold font-mono" data-testid="stat-total-rows">{summary.totalRows.toLocaleString()}</div>
                  <p className="text-xs text-muted-foreground mt-1">Total Rows</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold font-mono" data-testid="stat-unique-names">{summary.uniqueNames.toLocaleString()}</div>
                  <p className="text-xs text-muted-foreground mt-1">Unique Names</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold font-mono" data-testid="stat-resolved">{(summary.resolvedRate * 100).toFixed(1)}%</div>
                  <p className="text-xs text-muted-foreground mt-1">Resolved</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold font-mono" data-testid="stat-hq-rate">{(summary.highQualityRate * 100).toFixed(1)}%</div>
                  <p className="text-xs text-muted-foreground mt-1">High Quality</p>
                </CardContent>
              </Card>
            </div>

            {/* Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <Card className="lg:col-span-2">
                <CardHeader>
                  <CardTitle>Quality Funnel</CardTitle>
                  <CardDescription>Resolution flow from input names to confidence tiers</CardDescription>
                </CardHeader>
                <CardContent>
                  <SankeyChart summary={summary} results={results} includeVocabLayer={true} />
                </CardContent>
              </Card>

              <div className="space-y-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">Confidence Distribution</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="h-[180px]" data-testid="chart-confidence-pie">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie data={pieData} innerRadius={50} outerRadius={70} paddingAngle={2} dataKey="value">
                            {pieData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                          </Pie>
                          <RechartsTooltip />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="flex flex-wrap gap-2 mt-2">
                      {pieData.map(d => (
                        <span key={d.name} className="flex items-center gap-1 text-xs text-muted-foreground">
                          <span className="w-2 h-2 rounded-full inline-block" style={{ background: d.fill }} />
                          {d.name}: {d.value}
                        </span>
                      ))}
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">Vocabulary Coverage</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="h-[180px]" data-testid="chart-vocab-bar">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={barData} layout="vertical" margin={{ top: 0, right: 20, left: 10, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                          <XAxis type="number" fontSize={10} />
                          <YAxis dataKey="name" type="category" width={70} fontSize={10} />
                          <RechartsTooltip />
                          <Bar dataKey="value" fill="#3b82f6" radius={[0, 3, 3, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>

            {/* Report Summary */}
            <Card>
              <CardHeader>
                <CardTitle>Report Summary</CardTitle>
                <CardDescription>Overview of mapping results — also available as a downloadable Markdown report</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  {/* Summary Stats */}
                  <div>
                    <h4 className="text-sm font-semibold mb-2">Summary</h4>
                    <table className="w-full text-sm">
                      <tbody>
                        <tr className="border-b"><td className="py-1 text-muted-foreground">Total Rows</td><td className="py-1 text-right font-mono">{summary.totalRows.toLocaleString()}</td></tr>
                        <tr className="border-b"><td className="py-1 text-muted-foreground">Unique Names</td><td className="py-1 text-right font-mono">{summary.uniqueNames.toLocaleString()}</td></tr>
                        <tr className="border-b"><td className="py-1 text-muted-foreground">Resolved</td><td className="py-1 text-right font-mono">{summary.resolved.toLocaleString()} ({(summary.resolvedRate * 100).toFixed(1)}%)</td></tr>
                        <tr className="border-b"><td className="py-1 text-muted-foreground">Unresolved</td><td className="py-1 text-right font-mono">{(summary.uniqueNames - summary.resolved).toLocaleString()}</td></tr>
                        <tr><td className="py-1 text-muted-foreground">High Quality</td><td className="py-1 text-right font-mono">{(summary.highQualityRate * 100).toFixed(1)}%</td></tr>
                      </tbody>
                    </table>
                  </div>

                  {/* Confidence Tier Distribution */}
                  <div>
                    <h4 className="text-sm font-semibold mb-2">Confidence Tiers</h4>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-muted-foreground"><th className="py-1 text-left font-normal">Tier</th><th className="py-1 text-right font-normal">Count</th><th className="py-1 text-right font-normal">%</th></tr>
                      </thead>
                      <tbody>
                        {([["High", summary.confidenceTierDistribution.high, TIER_COLORS.high],
                           ["Medium", summary.confidenceTierDistribution.medium, TIER_COLORS.medium],
                           ["Low", summary.confidenceTierDistribution.low, TIER_COLORS.low],
                           ["Unknown", summary.confidenceTierDistribution.unknown, TIER_COLORS.unknown]] as [string, number, string][]).map(([tier, count, color]) => (
                          <tr key={tier} className="border-b last:border-0">
                            <td className="py-1 flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full inline-block" style={{ background: color }} />
                              {tier}
                            </td>
                            <td className="py-1 text-right font-mono">{count}</td>
                            <td className="py-1 text-right font-mono">{summary.uniqueNames > 0 ? (count / summary.uniqueNames * 100).toFixed(1) : "0.0"}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Vocabulary Coverage */}
                  <div>
                    <h4 className="text-sm font-semibold mb-2">Vocabulary Coverage</h4>
                    <div className="max-h-[200px] overflow-y-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b text-muted-foreground"><th className="py-1 text-left font-normal">Vocabulary</th><th className="py-1 text-right font-normal">Hits</th></tr>
                        </thead>
                        <tbody>
                          {Object.entries(summary.vocabularyCoverage)
                            .sort(([, a], [, b]) => b - a)
                            .map(([vocab, count]) => (
                              <tr key={vocab} className="border-b last:border-0">
                                <td className="py-1 font-mono text-xs">{vocab.toUpperCase()}</td>
                                <td className="py-1 text-right font-mono">{count}</td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>

                {/* Unresolved Names */}
                {summary.uniqueNames - summary.resolved > 0 && (
                  <div className="mt-4 pt-4 border-t">
                    <h4 className="text-sm font-semibold mb-2">Unresolved Names ({(summary.uniqueNames - summary.resolved).toLocaleString()})</h4>
                    <div className="flex flex-wrap gap-1.5">
                      {results.filter(r => !r.resolved).map(r => (
                        <Badge key={r.name} variant="outline" className="text-xs font-mono">
                          {r.name}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Needs Review */}
            {needsReview.length > 0 && (
              <Card>
                <CardHeader className="flex flex-row items-center justify-between py-4">
                  <div>
                    <CardTitle>Needs Review <Badge variant="secondary" className="ml-2">{needsReview.length}</Badge></CardTitle>
                    <CardDescription>Unresolved or low-confidence records. Flag items for follow-up or dismiss once reviewed.</CardDescription>
                  </div>
                  {flaggedNames.size > 0 && (
                    <div className="flex items-center gap-2">
                      <Badge variant="destructive" className="text-xs">
                        <Flag className="w-3 h-3 mr-1" /> {flaggedNames.size} flagged
                      </Badge>
                    </div>
                  )}
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Primary Curie</TableHead>
                        <TableHead>Tier</TableHead>
                        <TableHead>Reason</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {needsReview.slice(0, 25).map((row, i) => {
                        const isFlagged = flaggedNames.has(row.name);
                        return (
                          <TableRow
                            key={i}
                            data-testid={`row-review-${i}`}
                            className={isFlagged ? "bg-amber-50 dark:bg-amber-950/20" : undefined}
                          >
                            <TableCell className="font-mono text-sm max-w-[200px] truncate" title={row.name}>
                              {isFlagged && <Flag className="w-3 h-3 text-amber-500 inline mr-1" />}
                              {row.name}
                            </TableCell>
                            <TableCell className="font-mono text-xs text-muted-foreground">{row.primaryCurie || "-"}</TableCell>
                            <TableCell>
                              <Badge variant="outline" style={{ color: TIER_COLORS[row.confidenceTier || "unknown"], borderColor: "currentColor" }}>
                                {row.confidenceTier || "unresolved"}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {!row.resolved ? "No match found" : row.needsReview ? "Flagged by system" : "Low confidence"}
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex justify-end gap-1">
                                <Button
                                  variant={isFlagged ? "default" : "outline"}
                                  size="sm"
                                  className="h-7 px-2 text-xs"
                                  onClick={() => flagReviewItem(row.name)}
                                  title={isFlagged ? "Remove flag" : "Flag for follow-up"}
                                  data-testid={`btn-flag-review-${i}`}
                                >
                                  <Flag className="w-3 h-3 mr-1" />
                                  {isFlagged ? "Flagged" : "Flag"}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 text-xs text-muted-foreground"
                                  onClick={() => dismissReviewItem(row.name)}
                                  title="Dismiss from review list"
                                  data-testid={`btn-dismiss-review-${i}`}
                                >
                                  <X className="w-3 h-3 mr-1" />
                                  Dismiss
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                  {needsReview.length > 25 && (
                    <p className="text-xs text-center text-muted-foreground py-3">
                      Showing 25 of {needsReview.length} items. Download TSV for full list.
                    </p>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Full Results Table */}
            <Card>
              <CardHeader>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <CardTitle>All Results</CardTitle>
                    <CardDescription>{filteredResults.length.toLocaleString()} of {results.length.toLocaleString()} results</CardDescription>
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    <Button variant="outline" size="sm" onClick={handleDownloadMarkdown} data-testid="btn-download-md">
                      <Download className="w-4 h-4 mr-2" /> Markdown
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleDownloadCSV} data-testid="btn-download-csv">
                      <Download className="w-4 h-4 mr-2" /> CSV
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleDownloadTSV} data-testid="btn-download-tsv">
                      <Download className="w-4 h-4 mr-2" /> TSV
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleDownloadJSON} data-testid="btn-download-json">
                      <Download className="w-4 h-4 mr-2" /> JSON
                    </Button>
                  </div>
                </div>

                {/* Filter controls */}
                <div className="flex gap-3 mt-3 flex-wrap">
                  <div className="relative flex-1 min-w-[200px]">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Search by name..."
                      value={search}
                      onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                      className="pl-8"
                      data-testid="input-results-search"
                    />
                  </div>
                  <Select value={confidenceFilter} onValueChange={(v) => { setConfidenceFilter(v as ConfidenceFilter); setPage(1); }}>
                    <SelectTrigger className="w-44" data-testid="select-results-confidence">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Results</SelectItem>
                      <SelectItem value="high_medium">High + Medium</SelectItem>
                      <SelectItem value="high">High Only</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-8" />
                        <TableHead
                          className="cursor-pointer select-none hover:text-foreground"
                          onClick={() => toggleSort("name")}
                          data-testid="th-sort-name"
                        >
                          Name <SortIcon field="name" />
                        </TableHead>
                        <TableHead>Primary Curie</TableHead>
                        <TableHead
                          className="cursor-pointer select-none hover:text-foreground"
                          onClick={() => toggleSort("confidenceTier")}
                          data-testid="th-sort-tier"
                        >
                          Tier <SortIcon field="confidenceTier" />
                        </TableHead>
                        <TableHead
                          className="cursor-pointer select-none hover:text-foreground"
                          onClick={() => toggleSort("confidenceScore")}
                          data-testid="th-sort-score"
                        >
                          Score <SortIcon field="confidenceScore" />
                        </TableHead>
                        {providedIdColsForTable.map(col => (
                          <TableHead key={`provided-${col}`} className="text-xs">{col}</TableHead>
                        ))}
                        {visibleVocabCols.map(v => (
                          <TableHead key={v} className="text-xs">{v.toUpperCase()}</TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pagedResults.map((row, i) => {
                        const isExpanded = expandedRow === row.name;
                        return [
                          <TableRow
                            key={`row-${i}`}
                            className="cursor-pointer hover:bg-muted/40"
                            onClick={() => setExpandedRow(isExpanded ? null : row.name)}
                            data-testid={`row-result-${i}`}
                          >
                            <TableCell className="text-muted-foreground">
                              {isExpanded
                                ? <ChevronDown className="w-4 h-4" />
                                : <ChevronRight className="w-4 h-4" />
                              }
                            </TableCell>
                            <TableCell className="font-mono text-sm max-w-[200px] truncate" title={row.name}>
                              {row.name}
                            </TableCell>
                            <TableCell className="font-mono text-xs text-muted-foreground max-w-[160px] truncate" title={row.primaryCurie || ""}>
                              {row.primaryCurie || "-"}
                            </TableCell>
                            <TableCell>
                              {row.resolved ? (
                                <Badge variant="outline" style={{ color: TIER_COLORS[row.confidenceTier || "unknown"], borderColor: "currentColor" }}>
                                  {row.confidenceTier || "unknown"}
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="text-muted-foreground">unresolved</Badge>
                              )}
                            </TableCell>
                            <TableCell className="font-mono text-sm">
                              {row.confidenceScore != null ? row.confidenceScore.toFixed(3) : "-"}
                            </TableCell>
                            {providedIdColsForTable.map(col => {
                              const val = row.providedIds?.[col];
                              const display = Array.isArray(val) ? val.join("|") : (val || "-");
                              return (
                                <TableCell key={`provided-${col}`} className="font-mono text-xs text-muted-foreground max-w-[100px] truncate" title={typeof display === "string" ? display : ""}>
                                  {display}
                                </TableCell>
                              );
                            })}
                            {visibleVocabCols.map(v => (
                              <TableCell key={v} className="font-mono text-xs text-muted-foreground max-w-[100px] truncate">
                                {lookupIds(row, v)?.join(", ") || "-"}
                              </TableCell>
                            ))}
                          </TableRow>,
                          isExpanded && (
                            <TableRow key={`expand-${i}`} className="bg-muted/20">
                              <TableCell colSpan={5 + providedIdColsForTable.length + visibleVocabCols.length} className="py-3 px-6">
                                <div className="text-sm space-y-1">
                                  <p className="font-medium mb-2">Full Cross-References for: <span className="font-mono">{row.name}</span></p>
                                  {row.identifiers && Object.entries(row.identifiers).filter(([, ids]) => ids && ids.length > 0).map(([vocab, ids]) => (
                                    <div key={vocab} className="flex gap-2">
                                      <span className="text-muted-foreground w-20 shrink-0">{vocab.toUpperCase()}:</span>
                                      <span className="font-mono text-xs">{ids?.join(", ")}</span>
                                    </div>
                                  ))}
                                  {(!row.identifiers || Object.values(row.identifiers).every(ids => !ids || ids.length === 0)) && (
                                    <p className="text-muted-foreground text-xs">No cross-references available.</p>
                                  )}
                                  <EquivalentIds ids={row.kgEquivalentIds ?? {}} />
                                </div>
                              </TableCell>
                            </TableRow>
                          )
                        ].filter(Boolean);
                      })}
                      {pagedResults.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={5 + providedIdColsForTable.length + visibleVocabCols.length} className="text-center py-12 text-muted-foreground">
                            No results match the current filters.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-between px-4 py-3 border-t">
                    <p className="text-sm text-muted-foreground">
                      Page {page} of {totalPages} ({filteredResults.length.toLocaleString()} results)
                    </p>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setPage(p => Math.max(1, p - 1))}
                        disabled={page === 1}
                        data-testid="btn-prev-page"
                      >
                        Previous
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                        disabled={page === totalPages}
                        data-testid="btn-next-page"
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
