import { cn } from "@/lib/utils";

// The value is injected at build time (vite.config.ts). Outside Vite (unit tests) the constant does not exist.
const BUILD_SHA: string | null = typeof __BUILD_SHA__ !== "undefined" ? __BUILD_SHA__ : null;

/**
 * "build 3f2c1a9": the git commit this bundle was built from, so a screenshot or a bug report names the code.
 * Ported from ddharmon-ui. Renders nothing when the commit is unknown rather than showing a placeholder.
 */
export function BuildStamp({ className }: { className?: string }) {
  if (!BUILD_SHA) return null;
  return (
    <span
      data-testid="build-stamp"
      title="The git commit this page was built from."
      className={cn("font-mono text-xs text-on-chrome-muted", className)}
    >
      build {BUILD_SHA}
    </span>
  );
}
