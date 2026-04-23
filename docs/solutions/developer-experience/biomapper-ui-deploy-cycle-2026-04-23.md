---
title: "biomapper-ui full dev cycle: brainstorm to production on Lightsail"
date: 2026-04-23
category: developer-experience
module: biomapper-ui
problem_type: developer_experience
component: development_workflow
severity: medium
applies_when:
  - "Deploying a Replit-origin React/Express/FastAPI app to a bare server"
  - "Running multiple systemd services under the same user on a shared host"
  - "Migrating from Replit-managed auth (Clerk) to a standalone deployment"
tags: [deployment, aws-lightsail, replit-migration, clerk-auth, systemd, nginx, sse-proxy, biomapper]
---

# biomapper-ui full dev cycle: brainstorm to production on Lightsail

## Context

biomapper-ui is a React 19 + Express 5 + FastAPI entity linking app that maps compound names to standardized identifiers via the BioMapper2 API. It was built and running on Replit, and needed: API correctness verification (results came back suspiciously fast), better option documentation (tooltips), a benchmark mode placeholder, and production deployment to AWS Lightsail alongside the existing BioMapper2 API.

The full cycle used a structured brainstorm → plan → review → execute workflow with parallel subagent dispatch for independent work units.

## Guidance

### What worked well

- **Parallel subagent dispatch** for independent units (API verification, tooltip component, deploy configs dispatched simultaneously) reduced wall-clock time significantly.
- **API verification script with ground-truth fixtures** caught a real naming ambiguity ("Glucose" mapped to "Blood Glucose" via MESH; switching to "D-Glucose" resolved it). Non-empty smoke tests would have missed this — the API returned results, just wrong ones.
- **TypeScript typechecking** across all changes caught zero errors, confirming the tooltip and benchmark additions integrated cleanly.
- **Document review rounds** (coherence, feasibility, scope, security, adversarial) caught real issues pre-implementation: nginx proxy_buffering for SSE, Clerk auth ordering, biomapper SDK version pinning, touch target accessibility.

### Deployment gotchas encountered

**1. Port conflicts on shared server**
- Port 8000 held by `kraken-chatbot` (running since February), port 8080 by an SSH tunnel.
- Fix: Used ports 8002 (FastAPI) and 8080 (Express, became available). Always run `ss -tlnp | grep -E '8000|8080'` before configuring.

**2. Wrong API key variable name**
- Used `KESTREL_API_KEY` from biomapper2's env; the correct variable is `BIOMAPPER2_API_KEYS`.
- Fix: Read the actual env var names from the running service's environment, don't guess from memory.

**3. Clerk auth unavailable outside Replit** (session history)
- Clerk keys exist only in Replit's Secrets vault — injected at runtime, never on disk. Searching the Lightsail server found nothing.
- Fix: Made ClerkProvider conditional in App.tsx and Clerk middleware optional in Express app.ts. When `CLERK_SECRET_KEY` / `VITE_CLERK_PUBLISHABLE_KEY` are absent, the app runs without auth.

**4. Frontend blank page after build**
- Built with `VITE_CLERK_PUBLISHABLE_KEY=placeholder_will_update_later`. ClerkProvider crashed synchronously before React rendered anything — blank page, no visible error.
- Fix: The conditional Clerk guard (above) prevents this. Also: always check browser console for uncaught errors when a deployed React app shows a blank page.

**5. systemd ProtectHome broke biomapper2** (session history)
- `ProtectHome=read-only` in biomapper-ui's service made `~/.cache/uv/` read-only for all services under the `ubuntu` user. biomapper2 crash-looped 600+ times.
- Fix: Added `/home/ubuntu/.cache/uv` and `/tmp` to biomapper2's ReadWritePaths.
- See: `docs/solutions/runtime-errors/systemd-protecthome-breaks-sibling-service-cache-2026-04-23.md`

**6. systemd EnvironmentFile not loading** (session history)
- `.env` file was at the correct path with `EnvironmentFile=` in the service file, but env vars weren't reaching the process. The `Environment="PATH=..."` directive in the same unit may have interfered.
- Workaround: Added `Environment=` directives directly to the service file with values read from the biomapper2 env.

### Replit-to-Lightsail migration checklist

1. Audit all `process.env` reads — identify Replit-injected vars (`PORT`, `BASE_PATH`, `REPL_ID`) vs Replit Secrets
2. For each Replit Secret: provision on target host, or make the dependent feature optional
3. Check for Replit-specific infrastructure: Auth pane (Clerk), Nix packages, automatic HTTPS, port mapping
4. Enumerate occupied ports on the target host before writing service configs
5. If using Clerk: gate `ClerkProvider` initialization so absence doesn't crash the app
6. Vite env vars (`VITE_*`) are baked into the build — set them at build time, not runtime

## Why This Matters

Multi-service deployments on shared hosts create implicit dependencies that aren't visible in any single service's config. The ProtectHome bug was particularly insidious: the failing service's code and config hadn't changed, and the error message pointed to uv's cache — not to systemd security directives. Without this documentation, the next deployment to this host would likely hit the same issue.

The Replit migration gotchas (Clerk keys, injected env vars, blank page from invalid keys) are also non-obvious because Replit abstracts these away during development.

## When to Apply

- Deploying any Replit-origin application to a non-Replit host
- Adding a new systemd service to a host with existing services under the same user
- Using `ProtectHome=read-only` or `ProtectSystem=strict` in systemd units
- Migrating an app that uses Replit-managed authentication (Clerk)

## Examples

### Making Clerk auth optional (App.tsx)

```tsx
const clerkEnabled = !!clerkPubKey && clerkPubKey !== 'placeholder_will_update_later';

// In ProtectedRoute:
if (!clerkEnabled) return <Component />;

// In App:
{clerkEnabled ? <ClerkProviderWithRoutes /> : <NoAuthRoutes />}
```

### Making Express auth optional (app.ts)

```typescript
const clerkEnabled = !!process.env.CLERK_SECRET_KEY;

if (clerkEnabled) {
  app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
  app.use(clerkMiddleware());
}

app.use("/api/map", ...(clerkEnabled ? [requireMapAuth] : []), proxyMiddleware);
```

### nginx SSE proxy config (critical directives)

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_buffering off;        # Critical for SSE
    proxy_read_timeout 300s;    # Accommodates large batches
}
```

## Related

- Deploy configs: `deploy/` (systemd services, nginx, .env template, README)
- ProtectHome bug: `docs/solutions/runtime-errors/systemd-protecthome-breaks-sibling-service-cache-2026-04-23.md`
- Brainstorm: `docs/brainstorms/biomapper-ui-verification-and-enhancements-requirements.md`
- Plan: `docs/plans/2026-04-21-001-feat-verification-tooltips-deploy-plan.md`
- Verification script: `artifacts/python-api/scripts/verify_api.py`
