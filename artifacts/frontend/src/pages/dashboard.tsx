import { useState, useMemo } from "react";
import { useLocation, useParams } from "wouter";
import { useUser, useClerk } from "@clerk/react";
import { useMappingStream } from "@/hooks/use-mapping-stream";
import { useGetMappingResult, JobResult, MappingResultItem } from "@workspace/api-client-react";
import { SankeyChart } from "@/components/SankeyChart";
import { MappingSummary, MappingResult } from "@/types/mapping";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Download, AlertCircle, CheckCircle2, Loader2, ArrowLeft, LogOut } from "lucide-react";

const TIER_COLORS = {
  high: '#22c55e',
  medium: '#f59e0b',
  low: '#f97316',
  unknown: '#9ca3af',
};

export default function DashboardPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const [, setLocation] = useLocation();
  const { signOut } = useClerk();
  const { user } = useUser();
  
  // Try to use stream first, fallback to standard query if done or unavailable
  const { jobState, done } = useMappingStream(jobId || "");
  const { data: finalResult, isLoading } = useGetMappingResult(jobId || "", {
    query: { enabled: done || (!jobState && !!jobId) }
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
    const unknownCount = results.filter(r => r.confidenceTier === "unknown" || !r.confidenceTier).length;

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
      uniqueNames: Math.max(uniqueNames, 1), // prevent division by zero
      resolved,
      resolvedRate: uniqueNames > 0 ? resolved / uniqueNames : 0,
      highQualityRate: uniqueNames > 0 ? ((high + medium) / uniqueNames) : 0,
      confidenceTierDistribution: { high, medium, low, unknown: unknownCount },
      vocabularyCoverage: vocabCoverage
    };
  }, [jobData, results]);

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
    
    // Build headers dynamically from all possible vocabs
    const allVocabs = new Set<string>();
    results.forEach(r => {
      if (r.identifiers) Object.keys(r.identifiers).forEach(k => allVocabs.add(k));
    });
    
    const headers = ["Original Name", "Resolved", "Primary Curie", "Confidence Tier", "Confidence Score", ...Array.from(allVocabs)];
    
    const rows = results.map(r => {
      const row = [
        r.name,
        r.resolved ? "true" : "false",
        r.primaryCurie || "",
        r.confidenceTier || "",
        r.confidenceScore?.toString() || ""
      ];
      
      Array.from(allVocabs).forEach(v => {
        row.push(r.identifiers?.[v as keyof typeof r.identifiers]?.join("|") || "");
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
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10) : [];

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card px-6 py-3 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => setLocation("/upload")}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div>
            <h1 className="font-semibold tracking-tight text-foreground flex items-center gap-2">
              Job: <span className="font-mono text-sm font-normal text-muted-foreground">{jobId}</span>
              {isProcessing && <Badge variant="secondary" className="ml-2 animate-pulse">Processing</Badge>}
              {jobData.status === "complete" && <Badge variant="default" className="bg-green-600 ml-2">Complete</Badge>}
              {jobData.status === "error" && <Badge variant="destructive" className="ml-2">Failed</Badge>}
            </h1>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-muted-foreground">{user?.primaryEmailAddress?.emailAddress}</span>
          <Button variant="outline" size="sm" onClick={() => signOut()}>
            <LogOut className="w-4 h-4 mr-2" /> Sign Out
          </Button>
        </div>
      </header>

      <main className="p-6 max-w-7xl mx-auto space-y-6">
        
        {isProcessing && (
          <Card>
            <CardContent className="pt-6">
              <div className="flex justify-between text-sm mb-2 font-medium">
                <span>Progress: {jobData.completed} / {jobData.total}</span>
                <span>{progressPct}%</span>
              </div>
              <Progress value={progressPct} className="h-2" />
            </CardContent>
          </Card>
        )}

        {summary && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Card>
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold font-mono" data-testid="stat-total-rows">{summary.totalRows.toLocaleString()}</div>
                  <p className="text-sm text-muted-foreground mt-1">Total Rows</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold font-mono" data-testid="stat-unique-names">{summary.uniqueNames.toLocaleString()}</div>
                  <p className="text-sm text-muted-foreground mt-1">Unique Names (deduplicated)</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold font-mono" data-testid="stat-resolved">{(summary.resolvedRate * 100).toFixed(1)}%</div>
                  <p className="text-sm text-muted-foreground mt-1">Resolved (any match)</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold font-mono" data-testid="stat-hq-rate">{(summary.highQualityRate * 100).toFixed(1)}%</div>
                  <p className="text-sm text-muted-foreground mt-1">High Quality (high + medium)</p>
                </CardContent>
              </Card>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <Card className="lg:col-span-2">
                <CardHeader>
                  <CardTitle>Quality Funnel</CardTitle>
                  <CardDescription>Resolution flow from input to confidence tiers</CardDescription>
                </CardHeader>
                <CardContent>
                  <SankeyChart summary={summary} results={results} includeVocabLayer={true} />
                </CardContent>
              </Card>

              <div className="space-y-6">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">Confidence Tier Distribution</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="h-[200px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={pieData}
                            innerRadius={60}
                            outerRadius={80}
                            paddingAngle={2}
                            dataKey="value"
                          >
                            {pieData.map((entry, index) => (
                              <Cell key={`cell-${index}`} fill={entry.fill} />
                            ))}
                          </Pie>
                          <RechartsTooltip />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">Top Vocabulary Coverage</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="h-[200px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={barData} layout="vertical" margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                          <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                          <XAxis type="number" />
                          <YAxis dataKey="name" type="category" width={80} fontSize={12} />
                          <RechartsTooltip />
                          <Bar dataKey="value" fill="#3b82f6" radius={[0, 4, 4, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between py-4">
                <div>
                  <CardTitle>Needs Review</CardTitle>
                  <CardDescription>Records flagged as low confidence or unknown</CardDescription>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={handleDownloadTSV} data-testid="btn-download-tsv">
                    <Download className="w-4 h-4 mr-2" /> TSV
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleDownloadJSON} data-testid="btn-download-json">
                    <Download className="w-4 h-4 mr-2" /> JSON
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Original Name</TableHead>
                      <TableHead>Primary Curie</TableHead>
                      <TableHead>Confidence</TableHead>
                      <TableHead>Score</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {results.filter(r => r.confidenceTier === 'low' || r.confidenceTier === 'unknown' || !r.resolved).slice(0, 10).map((row, i) => (
                      <TableRow key={i}>
                        <TableCell className="font-mono text-sm">{row.name}</TableCell>
                        <TableCell className="font-mono text-sm text-muted-foreground">{row.primaryCurie || '-'}</TableCell>
                        <TableCell>
                          <Badge variant="outline" style={{ color: TIER_COLORS[row.confidenceTier as keyof typeof TIER_COLORS] || TIER_COLORS.unknown, borderColor: 'currentColor' }}>
                            {row.confidenceTier || 'unresolved'}
                          </Badge>
                        </TableCell>
                        <TableCell>{row.confidenceScore ? row.confidenceScore.toFixed(2) : '-'}</TableCell>
                        <TableCell>
                          {row.needsReview ? (
                            <span className="text-amber-500 text-sm font-medium flex items-center"><AlertCircle className="w-3 h-3 mr-1"/> Review</span>
                          ) : (
                            <span className="text-muted-foreground text-sm">-</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                    {results.filter(r => r.confidenceTier === 'low' || r.confidenceTier === 'unknown' || !r.resolved).length > 10 && (
                      <TableRow>
                        <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-4">
                          Showing top 10 items. Download full TSV for complete list.
                        </TableCell>
                      </TableRow>
                    )}
                    {results.filter(r => r.confidenceTier === 'low' || r.confidenceTier === 'unknown' || !r.resolved).length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-8">
                          No items currently need review.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
