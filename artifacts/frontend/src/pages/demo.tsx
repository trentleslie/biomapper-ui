import { useState } from "react";
import { useLocation } from "wouter";
import { DemoShell } from "@/components/DemoShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, Beaker, Database, BarChart3, Loader2 } from "lucide-react";

export default function DemoPage() {
  const [, setLocation] = useLocation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleStartDemo = async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/map/demo", { method: "POST" });

      if (res.status === 429) {
        setError("Demo is busy — try again in a moment.");
        setLoading(false);
        return;
      }

      if (!res.ok) {
        setError("Something went wrong. Please try again.");
        setLoading(false);
        return;
      }

      const data = await res.json();
      setLocation(`/job/${data.job_id}?demo=true`);
    } catch {
      setError("Could not connect to the server. Please try again.");
      setLoading(false);
    }
  };

  return (
    <DemoShell>
      <div className="max-w-3xl mx-auto">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-neutral-900 tracking-tight mb-3">
            See BioMapper in Action
          </h1>
          <p className="text-lg text-neutral-600 max-w-2xl mx-auto">
            BioMapper links raw compound names to standardized biological identifiers
            across databases like HMDB, ChEBI, PubChem, and more. Watch it process
            a real dataset in real-time.
          </p>
        </div>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Beaker className="w-5 h-5 text-ph-navy" />
              What the Demo Shows
            </CardTitle>
            <CardDescription>
              A complete entity linking workflow from start to finish
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="flex flex-col items-center text-center p-4 rounded-lg bg-neutral-50">
                <Database className="w-8 h-8 text-ph-navy mb-2" />
                <p className="text-sm font-medium text-neutral-900">100 Metabolites</p>
                <p className="text-xs text-neutral-500 mt-1">
                  Sample dataset with amino acids, lipids, vitamins, and more
                </p>
              </div>
              <div className="flex flex-col items-center text-center p-4 rounded-lg bg-neutral-50">
                <Beaker className="w-8 h-8 text-ph-navy mb-2" />
                <p className="text-sm font-medium text-neutral-900">Live Mapping</p>
                <p className="text-xs text-neutral-500 mt-1">
                  Real-time streaming progress as each compound is resolved
                </p>
              </div>
              <div className="flex flex-col items-center text-center p-4 rounded-lg bg-neutral-50">
                <BarChart3 className="w-8 h-8 text-ph-navy mb-2" />
                <p className="text-sm font-medium text-neutral-900">Full Dashboard</p>
                <p className="text-xs text-neutral-500 mt-1">
                  Confidence tiers, Sankey chart, results table, and downloads
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="mb-6">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-neutral-900">Preloaded Dataset</p>
                <p className="text-xs text-neutral-500 mt-0.5">
                  102 unique metabolite names &middot; Entity type: <Badge variant="outline" className="text-xs ml-1">biolink:SmallMolecule</Badge>
                </p>
              </div>
              <Badge variant="secondary">Ready</Badge>
            </div>
          </CardContent>
        </Card>

        {error && (
          <div className="mb-6 flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="text-center">
          <Button
            size="lg"
            className="h-12 px-8 text-lg"
            onClick={handleStartDemo}
            disabled={loading}
          >
            {loading ? (
              <>
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                Starting Demo...
              </>
            ) : (
              "Start Demo"
            )}
          </Button>
          <p className="text-xs text-neutral-500 mt-3">
            Takes about 30-60 seconds to map all compounds
          </p>
        </div>
      </div>
    </DemoShell>
  );
}
