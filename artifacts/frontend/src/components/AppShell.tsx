import { useRef, useState, type ReactNode } from "react";
import { useRoute, Link, useLocation, useSearch } from "wouter";
import { useUser, useClerk } from "@clerk/react";
import { UploadCloud, BarChart3, List, Flag, Target, LogOut, LogIn, GitMerge, type LucideIcon } from "lucide-react";
import { useListJobs, getListJobsQueryKey } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { EnvToggle } from "@/components/EnvToggle";
import { FeedbackButton } from "@/components/FeedbackButton";
import { PhMark } from "@/components/ph-logo";
import { BuildStamp } from "@/components/build-stamp";
import { useEnv } from "@/contexts/env-context";
import { cn } from "@/lib/utils";

// The shell's form is ported from Phenome-Health/ddharmon-ui (frontend/src/components/AppShell.tsx): no top bar, a
// left rail that rests as icons and opens over the content on hover or keyboard focus, the Phenome Health mark as
// the home link, and the account and build stamp at the rail's foot. The destinations are BioMapper's own.

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  isActive: (location: string) => boolean;
}

/** The rail's fixed destinations, in order. A new page adds one entry here. */
export const NAV_ITEMS: NavItem[] = [
  {
    label: "New job",
    href: "/upload",
    icon: UploadCloud,
    isActive: (location) => location === "/upload",
  },
  {
    label: "Harmonize cohorts",
    href: "/harmonize",
    icon: GitMerge,
    isActive: (location) => location === "/harmonize" || location.startsWith("/harmonize/"),
  },
  {
    label: "Benchmark",
    href: "/benchmark",
    icon: Target,
    isActive: (location) => location.startsWith("/benchmark"),
  },
  {
    label: "Flagged Annotations",
    href: "/flagged",
    icon: Flag,
    isActive: (location) => location === "/flagged",
  },
];

/** How long the pointer must rest on the rail before it opens, so crossing it does not flash it open. */
const NAV_HOVER_DELAY_MS = 120;

const railItemClass = "flex items-center gap-3 whitespace-nowrap rounded px-3 py-2 text-sm transition-colors";

function railItemTone(active: boolean) {
  return active
    ? "bg-on-chrome/12 font-semibold text-on-chrome"
    : "text-on-chrome-muted hover:bg-on-chrome/8 hover:text-on-chrome";
}

/**
 * One rail destination. Collapsed, the label is not drawn but stays the accessible name and the tooltip, so
 * collapsing hides text without removing a destination.
 */
export function RailLink({
  href,
  icon,
  label,
  active,
  collapsed,
}: {
  href: string;
  icon: ReactNode;
  label: string;
  active: boolean;
  collapsed: boolean;
}) {
  return (
    <Link
      href={href}
      aria-label={collapsed ? label : undefined}
      title={collapsed ? label : undefined}
      aria-current={active ? "page" : undefined}
      className={cn(railItemClass, railItemTone(active))}
    >
      {icon}
      {!collapsed && <span className="min-w-0 truncate">{label}</span>}
    </Link>
  );
}

/**
 * The frame both shells share. The rail keeps its icon width in the layout and the panel inside it widens over
 * the content, so the page never reflows under the pointer. Only keyboard focus (`:focus-visible`) opens it: a
 * clicked link keeps focus, and a rail that stayed open after every click would defeat the point.
 *
 * Content that should only be drawn when the rail is open must keep the same element and switch to `sr-only`
 * when collapsed (never unmount): a focused control that unmounted would drop focus and close the rail.
 */
export function ShellFrame({
  homeHref,
  homeLabel,
  header,
  nav,
  foot,
  children,
}: {
  homeHref: string;
  homeLabel: string;
  header?: (expanded: boolean) => ReactNode;
  nav: (expanded: boolean) => ReactNode;
  foot: (expanded: boolean) => ReactNode;
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const [keyFocus, setKeyFocus] = useState(false);
  const hoverTimer = useRef<number | null>(null);
  const expanded = hovered || keyFocus;

  return (
    <div data-testid="app-shell" className="flex h-screen flex-col overflow-hidden bg-surface-chrome">
      <div className="flex min-h-0 flex-1">
        <aside
          data-testid="app-nav"
          data-expanded={expanded ? "true" : "false"}
          className="relative w-14 shrink-0"
          onMouseEnter={() => {
            if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
            hoverTimer.current = window.setTimeout(() => setHovered(true), NAV_HOVER_DELAY_MS);
          }}
          onMouseLeave={() => {
            if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
            setHovered(false);
          }}
          onFocusCapture={(e) => {
            if ((e.target as HTMLElement).matches(":focus-visible")) setKeyFocus(true);
          }}
          onBlurCapture={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setKeyFocus(false);
          }}
        >
          <div
            data-testid="app-nav-panel"
            // The rail clips sideways on purpose: collapsed, it is an icon strip and labels are not drawn. Only its
            // vertical overflow (a short window) scrolls, and that axis carries the visible bar.
            data-clip-x="intended"
            className={cn(
              // z-40: above page content, below dialogs and popovers (z-50).
              "absolute inset-y-0 left-0 z-40 flex flex-col scroll-visible [scrollbar-gutter:auto]! overflow-x-hidden border-r border-rule-on-chrome bg-surface-chrome px-2 py-3 transition-[width] duration-150 ease-out motion-reduce:transition-none",
              expanded ? "w-60" : "w-14",
            )}
          >
            <Link
              href={homeHref}
              aria-label={homeLabel}
              title={expanded ? undefined : homeLabel}
              className="mb-2 flex items-center gap-3 rounded px-3 py-2 text-on-chrome transition-colors hover:bg-on-chrome/8"
            >
              <PhMark tone="ground" className="h-4 w-4 shrink-0" />
              {expanded && (
                <span className="flex min-w-0 flex-col leading-tight">
                  <span className="whitespace-nowrap text-sm font-semibold">BioMapper</span>
                  <span className="whitespace-nowrap text-xs text-on-chrome-muted">Phenome Health</span>
                </span>
              )}
            </Link>
            {header?.(expanded)}
            <nav aria-label="Main" className="space-y-1">
              {nav(expanded)}
            </nav>
            <div className="mt-auto space-y-1 border-t border-rule-on-chrome pt-3 text-xs">{foot(expanded)}</div>
          </div>
        </aside>
        {/* `relative` keeps absolutely positioned descendants (sr-only text included) inside this scroll context
            instead of extending the document; this element is the app's only vertical scroll. */}
        <main className="relative min-w-0 flex-1 scroll-visible bg-background text-foreground">
          <div className="mx-auto max-w-screen-2xl px-6 py-8 lg:px-8">{children}</div>
        </main>
      </div>
    </div>
  );
}

function RecentJobs({ currentJobId, collapsed }: { currentJobId: string | null; collapsed: boolean }) {
  const { data: recentJobs, isLoading } = useListJobs({
    query: { queryKey: getListJobsQueryKey(), retry: 1 },
  });
  const topJobs = (recentJobs || []).slice(0, 5);

  return (
    // Drawn only when the rail is open; collapsed it stays reachable by name for keyboard and screen readers.
    <div className={collapsed ? "sr-only" : "mt-4 space-y-1 border-t border-rule-on-chrome pt-3"}>
      <p className="px-3 pb-1 text-xs font-medium uppercase tracking-wider text-on-chrome-muted">Recent Jobs</p>
      {isLoading ? (
        <div className="space-y-2 px-3">
          <Skeleton className="h-8 w-full bg-on-chrome/10" />
          <Skeleton className="h-8 w-full bg-on-chrome/10" />
          <Skeleton className="h-8 w-full bg-on-chrome/10" />
        </div>
      ) : topJobs.length === 0 ? (
        <p className="px-3 text-xs text-on-chrome-muted">No recent jobs</p>
      ) : (
        <>
          {topJobs.map((j) => (
            <RailLink
              key={j.jobId}
              href={`/job/${j.jobId}`}
              icon={<BarChart3 className="h-4 w-4 shrink-0" />}
              label={j.displayName || `${j.jobId.slice(0, 8)}...`}
              active={currentJobId === j.jobId}
              collapsed={false}
            />
          ))}
          <RailLink
            href="/jobs"
            icon={<List className="h-4 w-4 shrink-0" />}
            label="View all"
            active={false}
            collapsed={false}
          />
        </>
      )}
    </div>
  );
}

function demoHeader(expanded: boolean) {
  return (
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
  );
}

function demoFoot(expanded: boolean) {
  return (
    <Link
      href="/login"
      aria-label={expanded ? undefined : "Sign In"}
      title={expanded ? undefined : "Sign In"}
      className={cn(
        railItemClass,
        "text-on-chrome hover:bg-on-chrome/8",
      )}
    >
      <LogIn aria-hidden className="h-4 w-4 shrink-0" />
      {expanded && <span>Sign In</span>}
    </Link>
  );
}

function AppNav({ expanded }: { expanded: boolean }) {
  const [location] = useLocation();
  const [isJobRoute, jobParams] = useRoute("/job/:jobId");
  const jobId = isJobRoute ? (jobParams as { jobId: string }).jobId : null;
  const isDemoJob = new URLSearchParams(useSearch()).get("demo") === "true";

  return (
    <>
      {NAV_ITEMS.map((item) => (
        <RailLink
          key={item.href}
          href={item.href}
          icon={<item.icon className="h-4 w-4 shrink-0" />}
          label={item.label}
          active={item.isActive(location)}
          collapsed={!expanded}
        />
      ))}
      {jobId && (
        <RailLink
          href={isDemoJob ? `/job/${jobId}?demo=true` : `/job/${jobId}`}
          icon={<BarChart3 className="h-4 w-4 shrink-0" />}
          label={`Job: ${jobId.slice(0, 8)}...`}
          active
          collapsed={!expanded}
        />
      )}
      <RecentJobs currentJobId={isDemoJob ? null : jobId} collapsed={!expanded} />
    </>
  );
}

function AppFoot({ expanded }: { expanded: boolean }) {
  const { user } = useUser();
  const { signOut } = useClerk();
  const { env } = useEnv();
  const email = user?.primaryEmailAddress?.emailAddress || "";

  return (
    <>
      {/* The API environment toggle, moved from the old top bar. One instance in both forms (see ShellFrame);
          at rest the rail shows which API new jobs go to. */}
      {!expanded && (
        <span
          aria-hidden
          title={env === "dev" ? "Development API" : "Production API"}
          className={cn(
            "mx-auto mb-1 block w-fit rounded px-1 py-0.5 text-[10px] font-semibold",
            env === "dev" ? "bg-warning-bg text-warning" : "text-on-chrome-muted",
          )}
        >
          {env === "dev" ? "DEV" : "PROD"}
        </span>
      )}
      <div className={expanded ? "mb-2 px-1.5" : "sr-only"}>
        <div className="w-fit rounded-md bg-neutral-0 p-0.5">
          <EnvToggle />
        </div>
      </div>
      {email && (
        <p title={email} className={expanded ? "truncate px-3 pt-1 text-on-chrome-muted" : "sr-only"}>
          {email}
        </p>
      )}
      <button
        type="button"
        onClick={() => void signOut()}
        aria-label={expanded ? undefined : "Sign out"}
        title={expanded ? undefined : "Sign out"}
        className={cn(railItemClass, "w-full text-left", railItemTone(false))}
      >
        <LogOut aria-hidden className="h-4 w-4 shrink-0" />
        {expanded && <span>Sign out</span>}
      </button>
      <BuildStamp className={expanded ? "block whitespace-nowrap px-3 pt-1" : "sr-only"} />
    </>
  );
}

/**
 * Shared adaptive shell keeping `<ShellFrame>{children}</ShellFrame>` at the same tree position across
 * `"demo"` -> `"app"` transitions so `children` stays mounted when auth settles.
 */
export function AdaptiveShell({
  mode,
  children,
}: {
  mode: "app" | "demo";
  children: ReactNode;
}) {
  const isApp = mode === "app";

  return (
    <>
      <ShellFrame
        homeHref={isApp ? "/" : "/demo"}
        homeLabel={isApp ? "BioMapper home" : "BioMapper demo home"}
        header={isApp ? undefined : demoHeader}
        nav={(expanded) => (isApp ? <AppNav expanded={expanded} /> : null)}
        foot={(expanded) => (isApp ? <AppFoot expanded={expanded} /> : demoFoot(expanded))}
      >
        {children}
      </ShellFrame>

      {isApp && <FeedbackButton />}
    </>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return <AdaptiveShell mode="app">{children}</AdaptiveShell>;
}
