import { type ReactNode } from "react";
import { AdaptiveShell } from "@/components/AppShell";

/**
 * The unauthenticated shell: the same frame as AppShell, with no app destinations (they all need an account),
 * the "Demo Mode" marker, and the way to sign in.
 */
export function DemoShell({ children }: { children: ReactNode }) {
  return <AdaptiveShell mode="demo">{children}</AdaptiveShell>;
}
