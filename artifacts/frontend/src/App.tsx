import { useEffect, useRef } from "react";
import { ClerkProvider, SignIn, SignUp, useClerk, useUser } from '@clerk/react';
import { Switch, Route, useLocation, Router as WouterRouter, Redirect } from 'wouter';
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

import UploadPage from "@/pages/upload";
import DashboardPage from "@/pages/dashboard";
import AccessDeniedPage from "@/pages/access-denied";
import NotFound from "@/pages/not-found";

const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const queryClient = new QueryClient();

// Clerk is optional — if no publishable key is set, the app runs without auth
const clerkEnabled = !!clerkPubKey && clerkPubKey !== 'placeholder_will_update_later';

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

// /login is the canonical sign-in page per spec
function LoginPage() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', marginTop: '2rem' }}>
      <SignIn routing="path" path={`${basePath}/login`} signUpUrl={`${basePath}/sign-up`} />
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

// Configurable allow-policy for UX gating (backend is authoritative source of truth).
// Defaults to phenomehealth.org only. Override via VITE_ALLOWED_EMAIL_DOMAINS or
// VITE_ALLOWED_EMAILS (comma-separated) environment variables.
const rawFrontendDomains = (import.meta.env.VITE_ALLOWED_EMAIL_DOMAINS as string | undefined) || "phenomehealth.org";
const ALLOWED_UX_DOMAINS = rawFrontendDomains.split(",").map((d: string) => d.trim().toLowerCase()).filter(Boolean);

const rawFrontendEmails = (import.meta.env.VITE_ALLOWED_EMAILS as string | undefined) || "";
const ALLOWED_UX_EMAILS = new Set(rawFrontendEmails.split(",").map((e: string) => e.trim().toLowerCase()).filter(Boolean));

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  // When Clerk is disabled, skip auth checks entirely
  if (!clerkEnabled) return <Component />;

  return <ClerkProtectedRoute component={Component} />;
}

function ClerkProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const { user, isLoaded, isSignedIn } = useUser();

  if (!isLoaded) return null;
  // Redirect unauthenticated users to /login (the canonical sign-in entry per spec)
  if (!isSignedIn) return <Redirect to="/login" />;

  const email = (user.primaryEmailAddress?.emailAddress || "").toLowerCase();
  const emailDomain = email.split("@")[1] || "";
  const isAllowed = ALLOWED_UX_EMAILS.has(email) || ALLOWED_UX_DOMAINS.includes(emailDomain);

  if (!isAllowed) {
    return <AccessDeniedPage />;
  }

  return <Component />;
}

function Router() {
  return (
    <Switch>
      {/* / = upload+config page (spec-required canonical upload route) */}
      <Route path="/">
        {() => <ProtectedRoute component={UploadPage} />}
      </Route>

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

      {/* /job/:jobId = canonical dashboard route per spec */}
      <Route path="/job/:jobId">
        {() => <ProtectedRoute component={DashboardPage} />}
      </Route>

      {/* /dashboard/:jobId redirects to canonical /job/:jobId */}
      <Route path="/dashboard/:jobId">
        {(params) => <Redirect to={`/job/${params.jobId}`} />}
      </Route>

      <Route component={NotFound} />
    </Switch>
  );
}

function ClerkProviderWithRoutes() {
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

function NoAuthRoutes() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Router />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      {clerkEnabled ? <ClerkProviderWithRoutes /> : <NoAuthRoutes />}
    </WouterRouter>
  );
}

export default App;
