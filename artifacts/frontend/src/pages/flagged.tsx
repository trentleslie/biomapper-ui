import { useListAllFlagsAggregated } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Flag, Download } from "lucide-react";

function escapeCsvField(value: string): string {
  // Quote all fields and double internal quotes.
  // Also prefix formula-trigger characters (=, +, -, @) with a tab to
  // neutralise spreadsheet formula injection (Excel / Google Sheets).
  const safe = /^[=+\-@]/.test(value) ? `\t${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export default function FlaggedPage() {
  const { data, isLoading, isError } = useListAllFlagsAggregated();

  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  const handleExportCsv = () => {
    const header = `${escapeCsvField("Metabolite Name")},${escapeCsvField("Flag Count")}`;
    const rows = items.map(
      (item) => `${escapeCsvField(item.name)},${escapeCsvField(String(item.count))}`,
    );
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "flagged-annotations.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const headerText = (() => {
    if (total === 0) return null;
    if (total === 1) return "1 flagged metabolite";
    if (total <= 1000 || total === items.length)
      return `${total.toLocaleString()} flagged metabolites`;
    return `Showing ${items.length.toLocaleString()} of ${total.toLocaleString()} flagged metabolites`;
  })();

  return (
    <>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-neutral-900 tracking-tight">
          Flagged Annotations
        </h1>
        <p className="text-sm text-neutral-500 mt-1">
          Metabolites flagged across all users, ranked by flag count.
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Flagged Metabolites</CardTitle>
            <CardDescription>
              {isLoading ? "Loading..." : headerText}
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportCsv}
            disabled={isLoading || items.length === 0}
          >
            <Download className="w-4 h-4 mr-1.5" />
            Export CSV
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Metabolite Name</TableHead>
                <TableHead className="text-right">Flag Count</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      <div className="h-4 bg-neutral-100 rounded animate-pulse w-48" />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="h-4 bg-neutral-100 rounded animate-pulse w-8 ml-auto" />
                    </TableCell>
                  </TableRow>
                ))
              ) : isError ? (
                <TableRow>
                  <TableCell colSpan={2} className="text-center py-12">
                    <div className="flex flex-col items-center gap-2 text-neutral-400">
                      <Flag className="w-8 h-8" />
                      <p>Failed to load flagged metabolites. Please try again.</p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={2} className="text-center py-12">
                    <div className="flex flex-col items-center gap-2 text-neutral-400">
                      <Flag className="w-8 h-8" />
                      <p>
                        No metabolites have been flagged yet. Flag metabolites from your results
                        page to mark them for attention — flags from all users are aggregated here.
                      </p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                items.map((item) => (
                  <TableRow key={item.name}>
                    <TableCell className="font-medium">{item.name}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {item.count.toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
