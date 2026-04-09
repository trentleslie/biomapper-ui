import { useState, useMemo, useCallback } from "react";
import { useLocation, useParams, useSearch } from "wouter";
import { useUser, useClerk } from "@clerk/react";
import { useMappingStream } from "@/hooks/use-mapping-stream";
import { useGetMappingResult, getGetMappingResultQueryKey, JobResult } from "@workspace/api-client-react";
import { SankeyChart } from "@/components/SankeyChart";
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
  ChevronDown, ChevronRight, ChevronUp, Search,
} from "lucide-react";

const TIER_COLORS: Record<string, string> = {
  high: '#22c55e',
  medium: '#f59e0b',
  low: '#f97316',
  unknown: '#9ca3af',
};

const ALL_ONTOLOGIES = ["hmdb", "chebi", "pubchem", "refmet", "lipidmaps", "kegg", "umls", "mesh", "unii", "chembl"] as const;
type OntologyKey = typeof ALL_ONTOLOGIES[number];

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

  const initialOntologies = params.get("ontologies")
    ? new Set(params.get("ontologies")!.split(",") as OntologyKey[])
    : new Set<OntologyKey>(ALL_ONTOLOGIES);
  const initialConfidence = (params.get("confidence") as ConfidenceFilter) || "all";

  const [visibleOntologies] = useState<Set<OntologyKey>>(initialOntologies);
  const [confidenceFilter, setConfidenceFilter] = useState<ConfidenceFilter>(initialConfidence);
  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [page, setPage] = useState(1);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  const { jobState, done } = useMappingStream(jobId || "");
  const { data: finalResult, isLoading } = useGetMappingResult(jobId || "", {
    query: {
      enabled: done || (!jobState && !!jobId),
      queryKey: getGetMappingResultQueryKey(jobId || ""),
    }
  });

  const job = (done && finalResult && "status" in finalResult) ? finalResult : (jobState || finalResult);
  const isError = job && "detail" in job;
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
            vocabCoverage[vocab] = (vocabCoverage[vocab] || 0) + 1;
          }
        });
      }
    });

    return {
      totalRows: results.length,
      uniqueNames: Math.max(uniqueNames, 1),
      resolved,
      resolvedRate: uniqueNames > 0 ? resolved / uniqueNames : 0,
      highQualityRate: uniqueNames > 0 ? (high + medium) / uniqueNames : 0,
      confidenceTierDistribution: { high, medium, low, unknown: unknownCount },
      vocabularyCoverage: vocabCoverage,
    };
  }, [jobData, results]);

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
  const needsReview = results.filter(r => r.needsReview || !r.resolved || r.confidenceTier === "unknown");

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

  const handleDownloadJSON = () => {
    if (!jobData || !summary) return;
    const data = JSON.stringify({ summary, results }, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mapping-results-${jobId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadTSV = () => {
    if (!results || results.length === 0) return;
    const allVocabs = new Set<string>();
    results.forEach(r => {
      if (r.identifiers) Object.keys(r.identifiers).forEach(k => allVocabs.add(k));
    });
    const vocabCols = Array.from(allVocabs).filter(v => visibleOntologies.has(v as OntologyKey));
    const headers = ["Original Name", "Resolved", "Primary Curie", "Confidence Tier", "Confidence Score", "Needs Review", ...vocabCols];
    const rows = results.map(r => {
      const row = [
        r.name,
        r.resolved ? "true" : "false",
        r.primaryCurie || "",
        r.confidenceTier || "",
        r.confidenceScore?.toString() || "",
        r.needsReview ? "true" : "false",
      ];
      vocabCols.forEach(v => {
        row.push(r.identifiers?.[v as OntologyKey]?.join("|") || "");
      });
      return row.join("\t");
    });
    const content = [headers.join("\t"), ...rows].join("\n");
    const blob = new Blob([content], { type: "text/tab-separated-values" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mapping-results-${jobId}.tsv`;
    a.click();
    URL.revokeObjectURL(url);
  };

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

  const visibleVocabCols = ALL_ONTOLOGIES.filter(k => visibleOntologies.has(k));

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
                  <SankeyChart summary={summary} results={results} includeVocabLayer={false} />
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

            {/* Needs Review */}
            {needsReview.length > 0 && (
              <Card>
                <CardHeader className="flex flex-row items-center justify-between py-4">
                  <div>
                    <CardTitle>Needs Review <Badge variant="secondary" className="ml-2">{needsReview.length}</Badge></CardTitle>
                    <CardDescription>Unresolved or low-confidence records requiring manual validation</CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Primary Curie</TableHead>
                        <TableHead>Tier</TableHead>
                        <TableHead>Score</TableHead>
                        <TableHead>Reason</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {needsReview.slice(0, 15).map((row, i) => (
                        <TableRow key={i} data-testid={`row-review-${i}`}>
                          <TableCell className="font-mono text-sm">{row.name}</TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">{row.primaryCurie || "-"}</TableCell>
                          <TableCell>
                            <Badge variant="outline" style={{ color: TIER_COLORS[row.confidenceTier || "unknown"], borderColor: "currentColor" }}>
                              {row.confidenceTier || "unresolved"}
                            </Badge>
                          </TableCell>
                          <TableCell>{row.confidenceScore ? row.confidenceScore.toFixed(2) : "-"}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {!row.resolved ? "No match found" : row.needsReview ? "Flagged for review" : "Low confidence"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {needsReview.length > 15 && (
                    <p className="text-xs text-center text-muted-foreground py-3">
                      Showing 15 of {needsReview.length} items. Download TSV for full list.
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
                            {visibleVocabCols.map(v => (
                              <TableCell key={v} className="font-mono text-xs text-muted-foreground max-w-[100px] truncate">
                                {row.identifiers?.[v]?.join(", ") || "-"}
                              </TableCell>
                            ))}
                          </TableRow>,
                          isExpanded && (
                            <TableRow key={`expand-${i}`} className="bg-muted/20">
                              <TableCell colSpan={5 + visibleVocabCols.length} className="py-3 px-6">
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
                                </div>
                              </TableCell>
                            </TableRow>
                          )
                        ].filter(Boolean);
                      })}
                      {pagedResults.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={5 + visibleVocabCols.length} className="text-center py-12 text-muted-foreground">
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
