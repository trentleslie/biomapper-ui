import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight } from "lucide-react";

interface EquivalentIdsProps {
  ids: Record<string, string[]>;
}

function PrefixGroup({ prefix, ids }: { prefix: string; ids: string[] }) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-sm text-neutral-500 hover:text-neutral-900 transition-colors"
      >
        {open ? (
          <ChevronDown className="w-3.5 h-3.5" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5" />
        )}
        <span className="font-medium">{prefix}</span>
        <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
          {ids.length}
        </Badge>
      </button>
      {open && (
        <div className="ml-5 mt-1 space-y-0.5">
          {ids.map((id) => (
            <div key={id} className="font-mono text-xs text-neutral-500">
              {id}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function EquivalentIds({ ids }: EquivalentIdsProps) {
  if (!ids || Object.keys(ids).length === 0) return null;

  const sortedPrefixes = Object.keys(ids).sort();
  const totalCount = sortedPrefixes.reduce((sum, p) => sum + (ids[p] ?? []).length, 0);

  return (
    <div className="mt-3">
      <p className="font-medium text-sm mb-1.5">
        Knowledge Graph Equivalent IDs
        <Badge variant="secondary" className="ml-2 text-[10px] px-1.5 py-0">
          {totalCount}
        </Badge>
      </p>
      <div className="space-y-1">
        {sortedPrefixes.map((prefix) => (
          <PrefixGroup key={prefix} prefix={prefix} ids={ids[prefix] ?? []} />
        ))}
      </div>
    </div>
  );
}
