import { useEffect, useRef } from "react";
import { ClerkProvider, SignIn, SignUp, useClerk, useUser } from '@clerk/react';
import { Switch, Route, useLocation, useSearch, Router as WouterRouter, Redirect } from 'wouter';
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

import UploadPage from "@/pages/upload";
import DashboardPage from "@/pages/dashboard";
import DemoPage from "@/pages/demo";
import JobsPage from "@/pages/jobs";

import NotFound from "@/pages/not-found";
import { EnvProvider } from "@/contexts/env-context";
import { AppShell } from "@/components/AppShell";
import { DemoShell } from "@/components/DemoShell";

const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
if (!clerkPubKey) {
  throw new Error("VITE_CLERK_PUBLISHABLE_KEY is required. Set it in your .env file.");
}
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const queryClient = new QueryClient();

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

// /login is the canonical sign-in page per spec
function LoginPage() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: '2rem', gap: '1.5rem' }}>
      <SignIn routing="path" path={`${basePath}/login`} signUpUrl={`${basePath}/sign-up`} />
      <div style={{ textAlign: 'center' }}>
        <a
          href={`${basePath}/demo`}
          style={{ color: '#113682', fontSize: '0.875rem', textDecoration: 'underline' }}
        >
          Or try the demo without signing in &rarr;
        </a>
      </div>
    </div>
  );
}

function SignUpPage() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', marginTop: '2rem' }}>
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/login`} />
    </div>
  );
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const queryClient = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (
        prevUserIdRef.current !== undefined &&
        prevUserIdRef.current !== userId
      ) {
        queryClient.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, queryClient]);

  return null;
}

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const { isLoaded, isSignedIn } = useUser();

  if (!isLoaded) return null;
  if (!isSignedIn) return <Redirect to="/login" />;

  return <AppShell><Component /></AppShell>;
}

function JobRouteGate() {
  const searchString = useSearch();
  const params = new URLSearchParams(searchString);
  const isDemo = params.get("demo") === "true";

  if (isDemo) {
    return <DemoShell><DashboardPage /></DemoShell>;
  }

  return <ProtectedRoute component={DashboardPage} />;
}

function Router() {
  return (
    <Switch>
      {/* / = upload+config page (spec-required canonical upload route) */}
      <Route path="/">
        {() => <ProtectedRoute component={UploadPage} />}
      </Route>

      {/* /demo = unauthenticated demo experience */}
      <Route path="/demo" component={DemoPage} />

      {/* /login = canonical sign-in entry per spec */}
      <Route path="/login/*?" component={LoginPage} />

      {/* /sign-in kept as alias for /login for Clerk compat */}
      <Route path="/sign-in/*?">
        {() => <Redirect to="/login" />}
      </Route>

      <Route path="/sign-up/*?" component={SignUpPage} />

      {/* /upload kept as alias for / */}
      <Route path="/upload">
        {() => <ProtectedRoute component={UploadPage} />}
      </Route>

      {/* /jobs = full job history page */}
      <Route path="/jobs">
        {() => <ProtectedRoute component={JobsPage} />}
      </Route>

      {/* /job/:jobId = canonical dashboard route; demo mode bypasses auth */}
      <Route path="/job/:jobId">
        {() => <JobRouteGate />}
      </Route>

      {/* /dashboard/:jobId redirects to canonical /job/:jobId */}
      <Route path="/dashboard/:jobId">
        {(params) => <Redirect to={`/job/${params.jobId}`} />}
      </Route>

      <Route component={NotFound} />
    </Switch>
  );
}

function AppWithClerk() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ClerkQueryClientCacheInvalidator />
          <Router />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

/** Dev-only: renders app without auth gating (Clerk still provides context for hooks) */
function DevBypassApp() {
  return (
    <ClerkProvider publishableKey={clerkPubKey}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AppShell>
            <Switch>
              <Route path="/">{() => <UploadPage />}</Route>
              <Route path="/upload">{() => <UploadPage />}</Route>
              <Route path="/job/:jobId">{() => <DashboardPage />}</Route>
              <Route component={NotFound} />
            </Switch>
          </AppShell>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  const bypassAuth = import.meta.env.DEV && import.meta.env.VITE_DEV_BYPASS_AUTH === "true";

  return (
    <EnvProvider>
      <WouterRouter base={basePath}>
        {bypassAuth ? <DevBypassApp /> : <AppWithClerk />}
      </WouterRouter>
    </EnvProvider>
  );
}

export default App;
