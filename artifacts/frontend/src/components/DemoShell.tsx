import { type ReactNode } from "react";
import { Link } from "wouter";
import { LogIn } from "lucide-react";
import { ShellFrame } from "@/components/AppShell";
import { cn } from "@/lib/utils";

/**
 * The unauthenticated shell: the same frame as AppShell, with no app destinations (they all need an account),
 * the "Demo Mode" marker, and the way to sign in.
 */
export function DemoShell({ children }: { children: ReactNode }) {
  return (
    <ShellFrame
      homeHref="/demo"
      homeLabel="BioMapper demo home"
      header={(expanded) => (
        <>
          {!expanded && (
            <span
              aria-hidden
              className="mx-auto mb-2 block w-fit rounded bg-on-chrome/12 px-1 py-0.5 text-[10px] font-semibold text-on-chrome"
            >
              DEMO
            </span>
          )}
          <span
            className={
              expanded
                ? "mx-3 mb-2 block w-fit whitespace-nowrap rounded bg-on-chrome/12 px-2 py-0.5 text-xs font-semibold text-on-chrome"
                : "sr-only"
            }
          >
            Demo Mode
          </span>
        </>
      )}
      nav={() => null}
      foot={(expanded) => (
        <Link
          href="/login"
          aria-label={expanded ? undefined : "Sign In"}
          title={expanded ? undefined : "Sign In"}
          className={cn(
            "flex items-center gap-3 whitespace-nowrap rounded px-3 py-2 text-sm transition-colors",
            "text-on-chrome hover:bg-on-chrome/8",
          )}
        >
          <LogIn aria-hidden className="h-4 w-4 shrink-0" />
          {expanded && <span>Sign In</span>}
        </Link>
      )}
    >
      {children}
    </ShellFrame>
  );
}
