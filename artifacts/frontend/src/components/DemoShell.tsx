import { type ReactNode } from "react";
import { Link } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function DemoShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col min-h-screen">
      {/* TopBar */}
      <header className="h-14 sticky top-0 z-40 bg-white border-b border-neutral-200 flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-2">
          <img src="/favicon.png" alt="Phenome Health" className="w-6 h-6" />
          <span className="text-sm font-semibold text-neutral-900">Phenome Health</span>
          <span className="text-sm text-neutral-500">/ BioMapper</span>
          <Badge variant="secondary" className="ml-2 text-xs">Demo Mode</Badge>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/login">
            <Button variant="outline" size="sm" className="text-sm">
              Sign In
            </Button>
          </Link>
        </div>
      </header>

      {/* Content — no sidebar */}
      <main className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-screen-2xl mx-auto px-6 lg:px-8 py-8">
          {children}
        </div>
      </main>
    </div>
  );
}
