import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";

interface FieldTooltipProps {
  children: React.ReactNode;
  label: string;
}

export function FieldTooltip({ children, label }: FieldTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className="p-1 inline-flex items-center"
          aria-label={label}
        >
          <Info size={14} className="text-neutral-400" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{children}</TooltipContent>
    </Tooltip>
  );
}
