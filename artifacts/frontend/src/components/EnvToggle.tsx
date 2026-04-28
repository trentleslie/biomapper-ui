import { useEnv } from "@/contexts/env-context";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function EnvToggle() {
  const { env, setEnv } = useEnv();

  return (
    <div className="flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <ToggleGroup
            type="single"
            value={env}
            onValueChange={(value) => {
              if (value) setEnv(value as "production" | "dev");
            }}
            aria-label="API environment"
            className="border rounded-md"
            size="sm"
          >
            <ToggleGroupItem
              value="production"
              aria-label="Production"
              className="px-2.5 text-xs data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
            >
              <span className="hidden sm:inline">Prod</span>
              <span className="sm:hidden">P</span>
            </ToggleGroupItem>
            <ToggleGroupItem
              value="dev"
              aria-label="Development"
              className="px-2.5 text-xs data-[state=on]:bg-amber-600 data-[state=on]:text-white"
            >
              <span className="hidden sm:inline">Dev</span>
              <span className="sm:hidden">D</span>
            </ToggleGroupItem>
          </ToggleGroup>
        </TooltipTrigger>
        <TooltipContent>
          <p>Changes affect new jobs only</p>
        </TooltipContent>
      </Tooltip>

      {env === "dev" && (
        <Badge
          variant="outline"
          className="bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-700 text-xs"
          role="status"
          aria-live="polite"
        >
          DEV API
        </Badge>
      )}
    </div>
  );
}
