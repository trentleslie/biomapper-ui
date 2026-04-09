import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <div className="min-h-screen w-full flex flex-col bg-background text-foreground">
      <header className="w-full px-6 py-4 flex items-center justify-between border-b border-border">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded bg-primary flex items-center justify-center text-primary-foreground font-bold">
            P
          </div>
          <span className="font-semibold text-lg tracking-tight">PhenomeHealth Linker</span>
        </div>
        <div className="flex items-center gap-4">
          <Link href="/sign-in">
            <Button variant="ghost" data-testid="btn-login">Sign In</Button>
          </Link>
          <Link href="/sign-up">
            <Button data-testid="btn-signup">Sign Up</Button>
          </Link>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-6 text-center max-w-4xl mx-auto">
        <h1 className="text-4xl md:text-6xl font-bold tracking-tight text-foreground mb-6">
          Precision Entity Linking for Metabolomics
        </h1>
        <p className="text-lg md:text-xl text-muted-foreground mb-10 max-w-2xl">
          Map raw compound names to biological ontologies with confidence. 
          Built for scientists who demand transparency, quality tiers, and comprehensive reporting.
        </p>
        
        <Link href="/sign-up">
          <Button size="lg" className="h-12 px-8 text-lg" data-testid="btn-get-started">
            Get Started
          </Button>
        </Link>
      </main>

      <footer className="py-6 text-center text-sm text-muted-foreground border-t border-border">
        &copy; {new Date().getFullYear()} PhenomeHealth. All rights reserved.
      </footer>
    </div>
  );
}
