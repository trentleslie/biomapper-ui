---
title: "feat: Add Unauthenticated Demo Mode"
type: feat
status: active
date: 2026-05-17
---

# feat: Add Unauthenticated Demo Mode

## Overview

Add a "Try Demo" experience that lets unauthenticated visitors see the full BioMapper dashboard in action using a bundled 100-row test dataset. The demo is a two-step flow: a demo home page describing what will happen, then the full dashboard with streaming results. Downloads work; uploads are disabled.

## Problem Frame

New visitors must currently sign in via Clerk before seeing anything. There's no way to evaluate the tool's value without committing to account creation. A demo mode with a pre-loaded dataset shows the full pipeline (streaming progress, results table, Sankey chart, confidence tiers) without authentication friction.

## Requirements Trace

- R1. "Try Demo" button visible on the login page without authentication
- R2. `/demo` route does NOT require Clerk sign-in
- R3. Demo uses bundled test CSV with hardcoded config (entity type: `biolink:SmallMolecule`, annotation mode: `missing`, default vocabularies)
- R4. Demo submits to the mapping API and shows the full dashboard experience with streaming progress
- R5. Demo page displays a "Demo Mode" banner/badge
- R6. After results, show a CTA to sign in for real usage
- R7. Only `/demo` and `/job/:id?demo=true` are unauthenticated — all other routes still require Clerk sign-in
- R8. Backend provides a demo endpoint that uses the bundled CSV and production BioMapper environment
- R9. Demo results are read-only — no uploads, no annotation editing. Downloads (CSV, TSV, JSON, Markdown) are allowed.
- R10. Demo home page explains what BioMapper does and what the demo will show before the user starts

## Scope Boundaries

- Simple global concurrency cap on demo jobs (max 3 in-flight); no per-IP rate limiting
- Demo submits a real mapping job each time "Start Demo" is clicked; no caching of results between sessions
- No persistent demo results — each demo starts a fresh job
- No benchmark mode integration
- No custom entity type or vocabulary selection in demo — uses hardcoded defaults

## Context & Research

### Relevant Code and Patterns

- `artifacts/frontend/src/App.tsx` — routing with `ProtectedRoute` wrapper; `/login` and `/sign-up` already bypass auth. `LoginPage` is a simple wrapper around Clerk's `<SignIn>` component — easy place to add a "Try Demo" link.
- `artifacts/frontend/src/pages/dashboard.tsx` — full results experience; uses `useParams()` for jobId and `useSearch()` for URL params
- `artifacts/frontend/src/hooks/use-mapping-stream.ts` — SSE streaming hook, reusable as-is
- `artifacts/python-api/routes/map.py` — `/batch` endpoint, simple names+config input, no backend auth
- `artifacts/python-api/services/jobs.py` — in-memory job store
- `artifacts/python-api/models/schemas.py` — `BatchRequest` with `MappingConfig`

### Key Observations

- The backend has **no authentication middleware** — auth is purely UX-level via Clerk on the frontend. The existing `/map/batch` endpoint can be called without auth tokens already.
- `DashboardPage` is tightly coupled to route params (`useParams`, `useSearch`). Rather than extracting it into a reusable component, the simplest approach is to navigate to `/job/{jobId}?demo=true` after submission and add demo-mode detection inside `DashboardPage`.
- The `useMappingStream` hook connects to `/api/map/stream/{jobId}` via EventSource — no auth headers needed.
- Clerk hooks (`useUser`, `useClerk`) return `{ isSignedIn: false }` for unauthenticated users — safe, but `AppShell` calls these for email/sign-out display, so the demo pages need a lightweight shell that avoids those hooks.

## Key Technical Decisions

- **Dedicated `/map/demo` backend endpoint** rather than a `demo: true` flag on `/batch`: Cleaner separation, allows the backend to own the CSV data, and enables a global concurrency cap specific to demo jobs.
- **Two-step demo flow**: Demo home page (`/demo`) explains the tool and shows the preloaded dataset → "Start Demo" button submits → navigates to `/job/{jobId}?demo=true` for the full dashboard. This gives users context before committing to a 30-60 second wait.
- **Navigate to `/job/{jobId}?demo=true`** rather than extracting DashboardPage into a reusable component: DashboardPage is 1000+ lines coupled to route params. Adding a `demo` query param and conditionally hiding upload/edit controls is far simpler than refactoring.
- **Demo uses production BioMapper environment**: Real results against the production mapping engine.
- **Downloads enabled, uploads disabled**: Users can export results (CSV, TSV, JSON, Markdown) but cannot upload their own data or edit annotations in demo mode.
- **Simple concurrency cap**: Max 3 active demo jobs globally. Return 429 when exceeded. Protects external API quota without complex per-IP tracking.
- **Lightweight DemoShell**: A minimal layout wrapper (header with logo + "Demo Mode" badge + "Sign In" link) that doesn't call Clerk user hooks. No sidebar.
- **Raw `fetch()`** for the `/map/demo` POST: Avoids updating the OpenAPI spec and re-running orval codegen for one trivial endpoint.

## Open Questions

### Resolved During Planning

- **Where does the "Try Demo" button go?** Below the Clerk `<SignIn>` component on the `/login` page. No routing changes needed — `/login` is already accessible to unauthenticated users.
- **Should the demo page use AppShell?** No — a lightweight `DemoShell` that doesn't call `useUser()`/`useClerk()`. Simple header with logo, "Demo Mode" badge, and "Sign In" link.
- **How does the frontend know the job ID?** The demo home page calls `POST /api/map/demo`, receives `job_id`, then navigates to `/job/{jobId}?demo=true`.
- **How does DashboardPage know it's in demo mode?** Reads `demo=true` from URL search params. Conditionally hides upload navigation and shows the demo banner/CTA.

### Deferred to Implementation

- Exact badge/banner styling for "Demo Mode" indicator
- Exact copy for the demo home page description
- Loading state between "Start Demo" click and navigation to dashboard

## Implementation Units

- [x] **Unit 1: Bundle test dataset and create demo endpoint with concurrency cap**

**Goal:** Add the 100-row test CSV to the API server and expose a `POST /map/demo` endpoint that reads it, extracts names, submits to the mapping pipeline, and enforces a global concurrency cap.

**Requirements:** R3, R8

**Dependencies:** None

**Files:**
- Create: `artifacts/python-api/data/demo_dataset.csv`
- Create: `artifacts/python-api/routes/demo.py`
- Modify: `artifacts/python-api/main.py` (register demo router)
- Test: `artifacts/python-api/tests/test_demo.py`

**Approach:**
- Copy the test dataset content into `artifacts/python-api/data/demo_dataset.csv` (column: `compound_name`)
- Read and validate the CSV at module import time (fail fast on startup if missing/malformed)
- Define `DEMO_NAME_COLUMN = "compound_name"` constant; raise clear error if column not found
- Track active demo jobs with a module-level counter; reject with 429 + `Retry-After` header when >= 3 in-flight
- New `routes/demo.py` with a single `POST /map/demo` endpoint:
  - Checks concurrency cap; returns 429 if exceeded
  - Uses the pre-loaded names list (cached at import time)
  - Constructs `BatchRequest(names=names, config=MappingConfig())` with production defaults
  - Creates a job via `job_store.create()` with the name count, `source="demo"` tag, and 10-minute TTL
  - Kicks off a wrapper coroutine via `BackgroundTasks` that calls `_run_mapping` inside a `try/finally` block, ensuring the counter is decremented regardless of success, error, or cancellation
  - Returns `{"job_id": "..."}` — same shape as `/map/batch`
- Explicitly passes `base_url=None` to use the server's default (production) environment
- Register router in `main.py` with `prefix="/map"` (so endpoint is `/map/demo`)

**Patterns to follow:**
- `artifacts/python-api/routes/map.py` — same pattern of creating a job, adding a background task, returning job_id

**Test scenarios:**
- Happy path: POST `/map/demo` returns 200 with `job_id` string; job appears in job_store with correct total count
- Happy path: Subsequent GET `/map/stream/{job_id}` returns SSE events for the created job
- Edge case: Multiple concurrent demo requests each create independent jobs (up to cap)
- Edge case: Fourth concurrent request returns 429 with Retry-After header
- Error path: If CSV file is missing at startup, application fails to start with clear error message

**Verification:**
- `POST /map/demo` returns a valid job_id
- The job processes the correct number of unique names from the CSV
- Streaming endpoint works for demo job_ids identically to regular jobs
- Concurrency cap is enforced

---

- [x] **Unit 2: Create demo home page and add "Try Demo" to login**

**Goal:** Create a `/demo` page that describes BioMapper, shows the preloaded dataset info, and provides a "Start Demo" button. Add a "Try Demo" link on the login page.

**Requirements:** R1, R2, R5, R7, R10

**Dependencies:** Unit 1

**Files:**
- Create: `artifacts/frontend/src/pages/demo.tsx`
- Create: `artifacts/frontend/src/components/DemoShell.tsx`
- Modify: `artifacts/frontend/src/App.tsx` (add `/demo` route outside `ProtectedRoute`, update `LoginPage`)

**Approach:**
- **DemoShell component**: Lightweight layout with header (logo + "Demo Mode" badge + "Sign In" link), no sidebar, no Clerk user hooks. Content area below.
- **Demo home page** (`/demo`):
  - Brief description of what BioMapper does (entity linking for metabolomics)
  - Explanation of what the demo will show: "We'll map 100 sample metabolite names to biological databases in real-time"
  - Summary of the preloaded dataset (100 compounds, SmallMolecule type, etc.)
  - "Start Demo" button that:
    - Calls `POST /api/map/demo` via raw `fetch()`
    - Shows loading state during the request
    - On success, navigates to `/job/{jobId}?demo=true`
    - On 429, shows "Demo is busy — try again in a moment"
    - On other errors, shows a friendly error state
  - Wrapped in `DemoShell`
- **Login page update**: Add a "Try Demo" link/button below the `<SignIn>` component, linking to `/demo`
- **App.tsx routing**: Add `<Route path="/demo" component={DemoPage} />` outside `ProtectedRoute`, same pattern as `/login`

**Patterns to follow:**
- `artifacts/frontend/src/App.tsx` — route registration pattern (see how `/login` is registered)
- `artifacts/frontend/src/components/AppShell.tsx` — layout shell pattern (DemoShell is a simpler version)

**Test scenarios:**
- Happy path: Visiting `/demo` without being signed in renders the demo home page (no redirect)
- Happy path: "Start Demo" button calls `/api/map/demo` and navigates to `/job/{jobId}?demo=true`
- Happy path: "Try Demo" link is visible on the `/login` page and navigates to `/demo`
- Edge case: If `/map/demo` returns 429, show "Demo is busy" message with retry option
- Edge case: If `/map/demo` fails with other error, show friendly error state
- Integration: Other routes (`/`, `/upload`, `/job/:id` without `demo=true`) still redirect to `/login` when unauthenticated

**Verification:**
- Unauthenticated user can visit `/demo` and see the demo home page
- "Start Demo" flow works end-to-end: click → API call → navigate to dashboard
- Login page shows the "Try Demo" option

---

- [x] **Unit 3: Add demo mode to DashboardPage**

**Goal:** Make `DashboardPage` aware of demo mode via `?demo=true` query param. In demo mode: show banner, hide upload/edit controls, allow downloads, show sign-in CTA after completion, and bypass auth.

**Requirements:** R4, R5, R6, R7, R9

**Dependencies:** Unit 2

**Files:**
- Modify: `artifacts/frontend/src/pages/dashboard.tsx`
- Modify: `artifacts/frontend/src/App.tsx` (allow `/job/:jobId` without auth when `demo=true`)

**Approach:**
- **Auth bypass for demo jobs**: In `App.tsx`, the `/job/:jobId` route renders a small `JobRouteGate` component that calls `useSearch()` to check for `demo=true`. If present, renders `DashboardPage` wrapped in `DemoShell`; otherwise renders via `ProtectedRoute` + `AppShell`. (Wouter's Route render function doesn't receive query params, so this intermediate component is needed.) DemoShell renders regardless of job validity — job-not-found errors display inside DemoShell with a "Try Again" link to `/demo`.
- **Demo mode detection in DashboardPage**: Read `demo` param from `useSearch()`. When `demo=true`:
  - Show a persistent "Demo Mode" banner/badge at the top (Alert or Badge component)
  - Hide "Needs Review" action buttons (Flag, Dismiss) — these imply annotation editing
  - Keep download buttons (CSV, TSV, JSON, Markdown) — downloads are allowed
  - After job completes, show a CTA card: "Ready to annotate your own data?" with button linking to `/login`
  - Hide sidebar navigation to upload page (handled by DemoShell having no sidebar)
  - Show brief contextual text during processing: "Mapping 100 sample metabolite names across biological databases..."
- **Error/loading states**:
  - If job not found or API error in demo mode, show friendly message + "Try Again" button linking back to `/demo`
  - SSE fallback: if streaming connection is lost after max retries, poll `GET /map/result/{jobId}` once to check if the job completed

**Patterns to follow:**
- `artifacts/frontend/src/pages/dashboard.tsx` — existing conditional rendering patterns (e.g., `isProcessing`, `isError`)
- `artifacts/frontend/src/components/ui/badge.tsx` — for demo badge

**Test scenarios:**
- Happy path: `/job/{jobId}?demo=true` renders without Clerk sign-in, wrapped in DemoShell
- Happy path: "Demo Mode" badge visible throughout
- Happy path: Download buttons (CSV, TSV, JSON, Markdown) work in demo mode
- Happy path: Streaming progress displays and updates in real-time
- Happy path: After job completes, sign-in CTA card appears
- Happy path: Flag/Dismiss buttons in "Needs Review" are hidden
- Edge case: `/job/{jobId}` WITHOUT `?demo=true` still requires auth (redirects to login)
- Edge case: Refreshing the page mid-processing reconnects to SSE stream
- Error path: If job fails, show error with "Try Again" link to `/demo`
- Integration: SSE fallback polls result endpoint if stream connection is lost

**Verification:**
- Full demo flow works: `/demo` → "Start Demo" → `/job/{id}?demo=true` with streaming results
- Downloads produce correct files
- Auth enforcement unchanged for non-demo job URLs
- Demo banner and CTA are visible and functional

## System-Wide Impact

- **Interaction graph:** The demo endpoint reuses the same `job_store` and `MapperService` as regular jobs. The frontend demo flow reuses `DashboardPage` and `useMappingStream` with a `demo=true` param for conditional behavior.
- **Error propagation:** Demo jobs use the same error handling as regular jobs. If the mapping API is down, the demo shows an appropriate error state with "Try Again" pointing back to `/demo`.
- **State lifecycle risks:** Demo jobs are ephemeral with a shorter TTL (10 minutes vs 1 hour for regular jobs) to limit memory accumulation from repeated demo use. No IndexedDB save for original data in demo mode (downloads use results-only format). Concurrency cap prevents burst accumulation.
- **API surface parity:** The `/map/demo` endpoint returns the same `{"job_id": "..."}` shape. Stream and result endpoints work identically for demo job IDs.
- **Unchanged invariants:** All authenticated routes remain protected. The Clerk provider still wraps the entire app. Demo routes bypass `ProtectedRoute` same as `/login` and `/sign-up` already do. The `?demo=true` param is the only auth bypass for `/job/:id`.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Demo hits production BioMapper API — could be slow or down | Demo shows streaming progress UX; error state is clear with "Try Again" option. |
| Abuse of demo endpoint (repeated calls) | Global concurrency cap of 3 active demo jobs; 429 when exceeded. |
| Demo results pollute job_store memory | 10-minute TTL for demo jobs (vs 1-hour for regular). Cap limits max in-flight to 3. |
| Future backend auth middleware breaks demo | If JWT validation is added later, `/map/demo` and stream/result endpoints for demo jobs must be exempted. |
| `?demo=true` used to bypass auth on non-demo jobs | Acceptable risk — job IDs are UUIDv4 (unguessable), no data sensitivity in mapping results. Defense-in-depth: frontend could verify job's `source` field matches `"demo"` but this is deferred as low-priority. |
| BioMapper API key missing/expired | CSV validated at startup; if API key is missing, demo endpoint returns clear 503. |

## Sources & References

- Origin document: `AGENT_PROMPT_demo_mode.md`
- Related code: `artifacts/frontend/src/App.tsx` (routing), `artifacts/python-api/routes/map.py` (batch endpoint)
