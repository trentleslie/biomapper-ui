import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight } from "lucide-react";

interface EquivalentIdsProps {
  ids: string[];
}

function groupByPrefix(ids: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const curie of ids) {
    const colonIdx = curie.indexOf(":");
    const prefix = colonIdx > 0 ? curie.slice(0, colonIdx) : "OTHER";
    const existing = groups.get(prefix);
    if (existing) {
      existing.push(curie);
    } else {
      groups.set(prefix, [curie]);
    }
  }
  return groups;
}

function PrefixGroup({ prefix, curies }: { prefix: string; curies: string[] }) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        {open ? (
          <ChevronDown className="w-3.5 h-3.5" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5" />
        )}
        <span className="font-medium">{prefix}</span>
        <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
          {curies.length}
        </Badge>
      </button>
      {open && (
        <div className="ml-5 mt-1 space-y-0.5">
          {curies.map((curie) => (
            <div key={curie} className="font-mono text-xs text-muted-foreground">
              {curie}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function EquivalentIds({ ids }: EquivalentIdsProps) {
  if (!ids || ids.length === 0) return null;

  const groups = groupByPrefix(ids);
  const sortedPrefixes = [...groups.keys()].sort();

  return (
    <div className="mt-3">
      <p className="font-medium text-sm mb-1.5">
        Knowledge Graph Equivalent IDs
        <Badge variant="secondary" className="ml-2 text-[10px] px-1.5 py-0">
          {ids.length}
        </Badge>
      </p>
      <div className="space-y-1">
        {sortedPrefixes.map((prefix) => (
          <PrefixGroup key={prefix} prefix={prefix} curies={groups.get(prefix)!} />
        ))}
      </div>
    </div>
  );
}
