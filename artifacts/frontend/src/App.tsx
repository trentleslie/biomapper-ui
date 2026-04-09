import { useEffect, useRef } from "react";
import { ClerkProvider, SignIn, SignUp, Show, useClerk, useUser } from '@clerk/react';
import { Switch, Route, useLocation, Router as WouterRouter, Redirect } from 'wouter';
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

import Home from "@/pages/home";
import UploadPage from "@/pages/upload";
import DashboardPage from "@/pages/dashboard";
import AccessDeniedPage from "@/pages/access-denied";
import NotFound from "@/pages/not-found";

const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const queryClient = new QueryClient();

if (!clerkPubKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
}

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

function SignInPage() {
  // To update login providers, app branding, or OAuth settings use the Auth
  // pane in the workspace toolbar. More information can be found in the Replit docs.
  return (
    <div style={{ display: 'flex', justifyContent: 'center', marginTop: '2rem' }}>
      <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
    </div>
  );
}

function SignUpPage() {
  // To update login providers, app branding, or OAuth settings use the Auth
  // pane in the workspace toolbar. More information can be found in the Replit docs.
  return (
    <div style={{ display: 'flex', justifyContent: 'center', marginTop: '2rem' }}>
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
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
  const { user, isLoaded, isSignedIn } = useUser();

  if (!isLoaded) return null;
  if (!isSignedIn) return <Redirect to="/" />;

  const email = (user.primaryEmailAddress?.emailAddress || "").toLowerCase();
  const emailDomain = email.split("@")[1] || "";
  const isAllowed = ALLOWED_UX_EMAILS.has(email) || ALLOWED_UX_DOMAINS.includes(emailDomain);

  if (!isAllowed) {
    return <AccessDeniedPage />;
  }

  return <Component />;
}

function HomeRedirect() {
  return (
    <>
      <Show when="signed-in">
        <Redirect to="/upload" />
      </Show>
      <Show when="signed-out">
        <Home />
      </Show>
    </>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={HomeRedirect} />
      <Route path="/sign-in/*?" component={SignInPage} />
      <Route path="/sign-up/*?" component={SignUpPage} />

      {/* /login is a canonical alias to the sign-in page */}
      <Route path="/login">
        {() => <Redirect to="/sign-in" />}
      </Route>

      <Route path="/upload">
        {() => <ProtectedRoute component={UploadPage} />}
      </Route>

      {/* /job/:jobId is the spec-required canonical route for a mapping job dashboard */}
      <Route path="/job/:jobId">
        {() => <ProtectedRoute component={DashboardPage} />}
      </Route>

      {/* /dashboard/:jobId kept as alias for backward compatibility */}
      <Route path="/dashboard/:jobId">
        {() => <ProtectedRoute component={DashboardPage} />}
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

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
