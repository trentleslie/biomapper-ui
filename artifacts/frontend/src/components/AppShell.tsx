import { type ReactNode } from "react";
import { useRoute, Link, useLocation } from "wouter";
import { useUser, useClerk } from "@clerk/react";
import { UploadCloud, BarChart3 } from "lucide-react";
import { EnvToggle } from "@/components/EnvToggle";
import { Button } from "@/components/ui/button";

function SideNav() {
  const [location] = useLocation();
  const [isJobRoute, jobParams] = useRoute("/job/:jobId");
  const jobId = isJobRoute ? (jobParams as { jobId: string }).jobId : null;

  const navItems: { label: string; href: string; icon: ReactNode; active: boolean }[] = [
    {
      label: "New job",
      href: "/",
      icon: <UploadCloud className="w-4 h-4" />,
      active: location === "/" || location === "/upload",
    },
  ];

  if (isJobRoute && jobId) {
    navItems.push({
      label: `Job: ${jobId.slice(0, 8)}...`,
      href: `/job/${jobId}`,
      icon: <BarChart3 className="w-4 h-4" />,
      active: true,
    });
  }

  return (
    <nav className="w-60 bg-neutral-50 border-r border-neutral-200 hidden lg:block py-4 px-3 space-y-1">
      {navItems.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={`flex items-center gap-3 px-3 py-2 rounded text-sm ${
            item.active
              ? "bg-neutral-200 text-neutral-900 font-medium"
              : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900"
          }`}
        >
          {item.icon}
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user } = useUser();
  const { signOut } = useClerk();
  const email = user?.primaryEmailAddress?.emailAddress || "";

  return (
    <div className="flex flex-col h-screen">
      {/* TopBar */}
      <header className="h-14 sticky top-0 z-40 bg-white border-b border-neutral-200 flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-2">
          <img src="/assets/favicon.png" alt="" className="w-6 h-6" />
          <span className="text-sm font-semibold text-neutral-900">Phenome Health</span>
          <span className="text-sm text-neutral-500">/ Biomapper</span>
        </div>
        <div className="flex items-center gap-3">
          {email && (
            <span className="text-sm text-neutral-500 truncate max-w-[200px] hidden sm:block">
              {email}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => signOut()}
            className="text-sm text-neutral-500"
          >
            Sign out
          </Button>
          <EnvToggle />
        </div>
      </header>

      {/* Body: SideNav + Content */}
      <div className="flex flex-1 min-h-0">
        <SideNav />
        <main className="flex-1 min-w-0 overflow-y-auto">
          <div className="max-w-screen-2xl mx-auto px-6 lg:px-8 py-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
