---
title: "feat: Verify API, add tooltips, benchmark stub, deploy to Lightsail"
type: feat
status: active
date: 2026-04-21
origin: docs/brainstorms/biomapper-ui-verification-and-enhancements-requirements.md
---

# Verify API, Add Tooltips, Benchmark Stub & Deploy to Lightsail

## Overview

This plan covers four workstreams for biomapper-ui: (1) verify the BioMapper2 API returns real results, (2) add tooltips and documentation to all upload page config fields, (3) add a stub benchmark mode toggle, and (4) deploy the app to the existing AWS Lightsail instance at `link.expertintheloop.io`.

## Problem Frame

Biomapper-UI is a React + Express + FastAPI entity linking app currently on Replit. API correctness is unverified (results came back suspiciously fast), the upload page lacks documentation for its configuration options, there's no path to benchmarking, and the app needs production deployment. (see origin: `docs/brainstorms/biomapper-ui-verification-and-enhancements-requirements.md`)

## Requirements Trace

- R1. Standalone test script verifying BioMapper2 API returns real results for known compounds
- R2. Batch refactor of Python mapping service — **deferred to future work**. Current per-entity approach is kept. If R1 reveals API issues, those are fixed in the existing per-entity code, not by switching to batch.
- R3. End-to-end UI test confirming real results on dashboard
- R4. Info-icon tooltips on all upload page config fields
- R5. Annotator descriptions alongside checkboxes (API or hardcoded fallback)
- R6. Explain default behaviors (annotators blank = all, annotation modes, entity type presets)
- R7. Benchmark mode toggle stub (UI only, "coming soon")
- R8. Deploy to Lightsail with systemd + nginx + HTTPS
- R9. Python service calls BioMapper2 at localhost on Lightsail
- R10. Environment variables configured on server, not hardcoded

## Scope Boundaries

- Not modifying the BioMapper2 API itself
- Not building the full benchmark workflow (deferred to separate brainstorm)
- Not adding CI/CD — manual deployment
- Not adding persistent storage — in-memory JobStore is fine
- R2 batch refactor deferred — current per-entity approach provides good UX and works correctly

### Deferred to Separate Tasks

- Full benchmark implementation (answer columns, metrics, comparison dashboard): separate brainstorm
- Batch refactor to SDK `map_entities()`: future optimization if performance warrants it

## Context & Research

### Relevant Code and Patterns

- **Upload page**: `artifacts/frontend/src/pages/upload.tsx` (637 lines) — React state-heavy, shadcn/ui components, inline hint spans on labels
- **Tooltip component**: `artifacts/frontend/src/components/ui/tooltip.tsx` — Radix `@radix-ui/react-tooltip`, already mounted via `<TooltipProvider>` in `App.tsx`
- **Icons**: `lucide-react` v0.545 — `Info`, `HelpCircle` available
- **Mapper service**: `artifacts/python-api/services/mapper.py` — `MapperService.map_batch()` with semaphore=10, per-entity streaming
- **Job store**: `artifacts/python-api/services/jobs.py` — in-memory dict, 1-hour TTL, `_lock` defined but unused (safe under single-writer asyncio pattern)
- **Express app**: `artifacts/api-server/src/app.ts` — Clerk auth, proxy to FastAPI, Clerk proxy middleware at `/api/__clerk`
- **Build output**: Frontend -> `artifacts/frontend/dist/public`, Express -> `artifacts/api-server/dist/index.mjs`
- **Clerk proxy**: `artifacts/api-server/src/clerkProxyMiddleware.ts` — active only when `NODE_ENV=production` + `CLERK_SECRET_KEY` set
- **Existing deployment reference**: `biomapper2` project at `35.161.242.62` uses systemd + nginx + certbot

### Institutional Learnings

No `docs/solutions/` exists in this repo.

## Key Technical Decisions

- **Keep per-entity approach for now**: The current `map_entity()` per-name approach with semaphore=10 provides per-entity streaming progress. Switching to `map_entities()` batch would degrade progress UX (chunked jumps). The current approach works — batch refactor is deferred to future work.
- **Subdomain `link.expertintheloop.io`**: Separate subdomain avoids path-prefix complexity in Vite BASE_URL, nginx routing, and Clerk redirect URLs. Requires DNS A record pointing to `35.161.242.62` and a separate certbot cert.
- **Tooltips, not popovers**: Use `<Tooltip>` (hover) with `<Info>` icon for brief help text on each field. Consistent, lightweight, doesn't require clicking. The `TooltipProvider` is already in `App.tsx`.
- **nginx serves frontend + proxies API**: nginx serves static files from the Vite build at `/`, proxies `/api/*` to Express on port 8080. Express proxies `/api/map/*` and `/api/discovery/*` to FastAPI on port 8000. This replicates what Replit does.

## Open Questions

### Resolved During Planning

- **Batch refactor approach**: Keep current per-entity approach; batch is a future optimization. Resolves the deferred question about progress streaming.
- **Subdomain**: `link.expertintheloop.io`. Resolves the deferred question about URL.
- **JobStore lock safety**: Single-writer asyncio pattern is safe. The `_lock` should be used only if batch writes are introduced later.

### Deferred to Implementation

- **Annotator descriptions from API**: Resolved — the OpenAPI spec (`lib/api-spec/openapi.yaml`) already defines `description: type: string, nullable: true` on the Annotator schema. The generated client types include it. Unit 4 should use `a.description` with a null guard, falling back to hardcoded descriptions only if the field is null/empty.
- **Clerk redirect URL configuration**: Unit 7 includes updating Clerk dashboard redirect URLs as a deployment step. The exact Clerk UI may differ; the implementer should consult Clerk docs during deployment.
- **Port availability on Lightsail**: Verify ports 8000 and 8080 aren't in use before configuring services. If occupied, reassign in `.env`.

## Implementation Units

- [ ] **Unit 1: API verification test script**

**Goal:** Confirm the BioMapper2 API returns real, correct results for known compounds.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Create: `artifacts/python-api/scripts/verify_api.py`

**Approach:**
- Standalone async Python script that creates a `BioMapperClient()` (use SDK default 30s timeout for main verification; use `timeout=5.0` only for the unreachable-server edge case test), calls `map_entity()` for 5 known compounds
- Include an expected-identifier fixture for ground-truth comparison:
  - L-Histidine: HMDB0000177, CHEBI:15971
  - Glucose: HMDB0000122, CHEBI:17234
  - Acetyl-CoA: HMDB0001206, CHEBI:15351
  - Creatinine: HMDB0000562, CHEBI:16737
  - Tryptophan: HMDB0000929, CHEBI:16828
- Pass/fail criterion: for each compound, at least one expected identifier appears in the returned identifier set (normalized comparison — strip prefixes, compare numeric portions). This catches the specific failure mode of "fast but wrong" cached results.
- Print full results: resolved status, primary_curie, confidence_tier, confidence_score, all identifiers, and PASS/FAIL per compound
- Use the production API at `biomapper.expertintheloop.io` with the configured API key. Accept `BIOMAPPER_BASE_URL` override so the same script can verify localhost on Lightsail.
- Exit with non-zero status if any compound fails expected-value assertions
- After successful verification, pin the exact biomapper version in `artifacts/python-api/requirements.txt` (change `biomapper>=1.0.0` to `biomapper==<verified version>`)

**Patterns to follow:**
- `artifacts/python-api/services/mapper.py` for `BioMapperClient` usage pattern

**Test scenarios:**
- Happy path: Each compound resolves with `resolved=True`, and at least one expected identifier (HMDB or CHEBI) appears in the returned set — script prints PASS per compound and exits 0
- Error path: Script with invalid/missing API key prints clear error message and exits non-zero
- Error path: If API returns results that don't match expected identifiers (e.g., wrong HMDB ID for L-Histidine), script prints FAIL with expected vs actual and exits non-zero
- Edge case: Script with `BIOMAPPER_BASE_URL` override to a non-existent server times out within ~7 seconds (using a separate `BioMapperClient(timeout=5.0)` for this test only) and exits non-zero with a clear timeout message

**Verification:**
- Running the script produces PASS for all 5 test compounds with matching expected identifiers
- Results include real identifiers confirming the API is genuinely mapping, not returning cached/wrong data

---

- [ ] **Unit 2: End-to-end UI verification**

**Goal:** Confirm the full UI pipeline produces real results on the dashboard.

**Requirements:** R3

**Dependencies:** Unit 1 (API confirmed working)

**Files:**
- Create: `artifacts/python-api/scripts/verify_e2e_compounds.tsv` (small test file with 5-10 compounds)
- Create: `artifacts/python-api/scripts/verify_e2e_compounds.expected.json` (expected results artifact, committed for regression diffing)

**Approach:**
- Create a TSV test file with known compounds (same ones from Unit 1 plus a few more, including one intentionally obscure name to test unresolved handling)
- Include columns: `name`, `hmdb_id` (as a hint column) for 2-3 compounds
- Manual test: start dev servers, upload the file, verify dashboard shows real results with identifiers and confidence scores
- After verification, export the dashboard's JSON results and save as `verify_e2e_compounds.expected.json`. Commit this artifact so future runs can diff against it to catch regressions without a test framework.

**Test scenarios:**
- Happy path: Upload test file, select name column, start mapping. Dashboard shows progress streaming, then results with real HMDB/CHEBI/PUBCHEM IDs and confidence tiers
- Edge case: Upload with a compound that has no known mapping — verify it shows as unresolved with appropriate confidence tier

**Test expectation: none** — this is a manual verification step, not automated tests. The committed expected-results JSON serves as a regression artifact.

**Verification:**
- Dashboard shows populated identifier columns (not all empty)
- Confidence tiers are distributed (not all "unknown")
- Download (JSON or TSV) contains real identifier values
- Expected results JSON committed for future regression comparison

---

- [ ] **Unit 3: Tooltip helper component**

**Goal:** Create a reusable `FieldTooltip` component for consistent info-icon tooltips across the upload page.

**Requirements:** R4

**Dependencies:** None

**Files:**
- Create: `artifacts/frontend/src/components/field-tooltip.tsx`

**Approach:**
- Small component that renders `<Tooltip><TooltipTrigger asChild><button className="p-1 inline-flex" aria-label={label}><Info size={14} className="text-muted-foreground" /></button></TooltipTrigger><TooltipContent>children</TooltipContent></Tooltip>`
- Accept `children` (tooltip content) and `label` (aria-label string, e.g., "Help: Name Column") as props
- Use `lucide-react` `Info` icon, sized small, muted color to match existing inline hint text style. The wrapping button has `p-1` padding to meet WCAG touch target guidelines (44x44 hit area) while keeping the icon visually small.
- Add `max-w-xs` (20rem) to `TooltipContent` className to prevent unbounded line length for multi-sentence tooltips
- Keep it minimal — inline next to labels

**Patterns to follow:**
- `artifacts/frontend/src/components/ui/tooltip.tsx` for tooltip primitives
- Existing label pattern in `upload.tsx`: `<Label>Field Name <span className="text-muted-foreground...">hint</span></Label>`

**Test scenarios:**
- Happy path: Tooltip renders an info icon that shows content on hover
- Edge case: Long tooltip content wraps correctly within `TooltipContent` max-width

**Verification:**
- Component renders inline with labels without layout disruption
- Hover shows tooltip content, dismiss on mouse leave

---

- [ ] **Unit 4: Add tooltips to all upload page config fields**

**Goal:** Add info-icon tooltips to every configuration field on the upload page with helpful descriptions.

**Requirements:** R4, R5, R6

**Dependencies:** Unit 3 (FieldTooltip component)

**Files:**
- Modify: `artifacts/frontend/src/pages/upload.tsx`

**Approach:**
- Add `<FieldTooltip>` next to each `<Label>` for the 7 config fields
- Tooltip content for each field:
  - **Name Column**: "Select the column containing entity names to map (e.g., compound names, metabolite names). Each unique name will be sent to BioMapper for identification."
  - **Entity Type**: "The Biolink ontology class for your entities. This determines which vocabularies and identification strategies are used. SmallMolecule is correct for most metabolomics data."
  - **Annotation Mode**: "Controls how BioMapper handles identifier annotation. 'Missing' only annotates entities without existing IDs. 'All' re-annotates everything. 'None' skips annotation entirely."
  - **Annotators**: "Select specific annotators to use, or leave all unchecked to use the full default set. Each annotator uses a different strategy (text search, vector similarity, etc.) to find matches."
  - **Provided ID Columns**: "Columns with known identifiers (e.g., HMDB IDs, CHEBI IDs) that help BioMapper confirm or improve matches. These act as hints, not constraints."
  - **Display Vocabularies**: "Choose which identifier vocabularies appear as columns in the results table. Presets are based on entity type; switch to 'Show all' to search across 300+ vocabularies."
  - **Confidence Filter**: "Filter which results appear in the dashboard. 'High + Medium' hides uncertain matches. 'High Only' shows only the most confident identifications."
- For annotators (R5): use `a.description` from the API (the OpenAPI spec defines it as `string, nullable`). If null/empty, fall back to hardcoded descriptions for known annotators (kestrel-hybrid-search, kestrel-text-search, kestrel-vector-search, metabolomics-workbench). For unknown annotators with no description, show the annotator slug with muted "(no description available)" text — don't silently omit. Log a console warning in dev mode when an annotator has no description and isn't in the hardcoded fallback map.
- For defaults (R6): the tooltip content above already explains defaults. Additionally, update the inline hint text on Annotation Mode to be more descriptive.

**Patterns to follow:**
- Existing inline hint spans in `upload.tsx` for tone and brevity
- `data-testid` convention for any new interactive elements

**Test scenarios:**
- Happy path: Each of the 7 config fields shows an info icon; hovering displays the correct tooltip text
- Happy path: Annotator checkboxes show descriptions (from API or hardcoded fallback)
- Edge case: Tooltip text remains readable at narrow viewport widths (Tailwind responsive)

**Verification:**
- All 7 fields have visible info icons
- Tooltip content is accurate and helpful
- Annotator descriptions appear next to each annotator checkbox
- No layout regressions on the upload page

---

- [ ] **Unit 5: Benchmark mode toggle stub**

**Goal:** Add a mode toggle at the top of the upload page for "Entity Linking" vs "Benchmark" with a "coming soon" state.

**Requirements:** R7

**Dependencies:** Unit 3 (FieldTooltip for the help icon)

**Files:**
- Modify: `artifacts/frontend/src/pages/upload.tsx`

**Approach:**
- Add a `Tabs` component (from `artifacts/frontend/src/components/ui/tabs.tsx`) at the top of the upload page, above the file drop zone
- Two tabs: "Entity Linking" (default, active) and "Benchmark"
- Next to the tabs (right-aligned within a flex row, with at least 8px gap), add a `<FieldTooltip>` with: "Entity Linking maps your compound names to standardized identifiers. Benchmark mode (coming soon) lets you evaluate mapping accuracy against known-correct data."
- When "Benchmark" tab is selected: show a centered "Coming soon" message with a brief description, hide the file upload and config sections
- Store mode in local state: `const [mode, setMode] = useState<'link' | 'benchmark'>('link')`
- The rest of the upload page renders only when `mode === 'link'`

**Patterns to follow:**
- `artifacts/frontend/src/components/ui/tabs.tsx` for tab primitives
- Existing page layout and card styling in `upload.tsx`

**Test scenarios:**
- Happy path: Page loads with "Entity Linking" tab active, full upload flow visible
- Happy path: Clicking "Benchmark" tab shows "Coming soon" message and hides upload form
- Happy path: Switching back to "Entity Linking" restores the upload flow
- Edge case: Tooltip on the help icon explains both modes clearly

**Verification:**
- Mode toggle is visible above the file drop zone
- "Entity Linking" is the default active tab
- "Benchmark" shows a clean "coming soon" state
- No regressions in the existing upload flow

---

- [ ] **Unit 6: Deployment configuration files**

**Goal:** Create systemd service files, nginx config, and environment template for Lightsail deployment.

**Requirements:** R8, R9, R10

**Dependencies:** None (can be done in parallel with earlier units)

**Files:**
- Create: `deploy/biomapper-ui-express.service`
- Create: `deploy/biomapper-ui-python.service`
- Create: `deploy/nginx-link.conf`
- Create: `deploy/.env.example`
- Create: `deploy/README.md`

**Approach:**
- **Two systemd services**: one for Express (Node.js), one for FastAPI (Python/uvicorn). Follow the pattern from `biomapper2/deploy/biomapper2-api.service` — run as `ubuntu` user, auto-restart, security hardening (NoNewPrivileges, ProtectSystem=strict). Use `EnvironmentFile=` directive to load env vars (not `load_dotenv`). Note: `artifacts/python-api/main.py` has a hardcoded `load_dotenv` path 3 dirs up — the systemd `EnvironmentFile=` will take precedence since env vars will already be set when the process starts, but place the `.env` at the repo root to be safe for both paths.
  - Express service: `node --enable-source-maps /path/to/artifacts/api-server/dist/index.mjs` with `PORT=8080`, `NODE_ENV=production`
  - Python service: `uvicorn main:app --host 127.0.0.1 --port 8000` with `BIOMAPPER_BASE_URL=http://localhost:8001/api/v1` and `BIOMAPPER_API_KEY` from env
- **Production CORS hardening**: Tighten FastAPI's `CORSMiddleware` from `allow_origins=["*"]` to `allow_origins=["http://127.0.0.1:8080"]` (the Express backend origin) for production. The wildcard is fine for development but unnecessary in production since FastAPI is only reachable from localhost.
- **nginx config** for `link.expertintheloop.io`:
  - `server_name link.expertintheloop.io`
  - `root /path/to/artifacts/frontend/dist/public` with `try_files $uri $uri/ /index.html` for SPA
  - `location /api/ { proxy_pass http://127.0.0.1:8080; }` with headers: `proxy_http_version 1.1;`, `proxy_set_header Connection '';`, `proxy_buffering off;`, `proxy_read_timeout 300s;`, `proxy_set_header X-Real-IP $remote_addr;`, `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`, `proxy_set_header X-Forwarded-Proto $scheme;`. The `proxy_http_version 1.1`, empty `Connection`, and `proxy_buffering off` are critical for SSE streaming. The 300s read timeout accommodates large batches.
  - `client_max_body_size 10m;` — prevents oversized request bodies from reaching the backend
  - SSL will be added by certbot after initial setup
- **.env.example** with all required variables:
  - `PORT` (Express, default 8080)
  - `NODE_ENV` (must be `production`)
  - `CLERK_SECRET_KEY` (server-side Clerk auth)
  - `VITE_CLERK_PUBLISHABLE_KEY` (baked into frontend build)
  - `VITE_CLERK_PROXY_URL` (e.g., `https://link.expertintheloop.io/api/__clerk`)
  - `BIOMAPPER_API_KEY` (for BioMapper2 calls)
  - `BIOMAPPER_BASE_URL` (set to `http://localhost:8001/api/v1`)
  - `PYTHON_API_PORT` (default 8000)
  - `ALLOWED_EMAIL_DOMAINS` (default `phenomehealth.org`)
  - `ALLOWED_EMAILS` (optional, comma-separated)
- **deploy/README.md** with step-by-step deployment instructions using variable placeholders (e.g., `$DEPLOY_DIR`, `$DOMAIN`) that Unit 7 fills in with actual values during deployment. This makes the README reusable for future redeploys or disaster recovery, not just a single-use artifact.

**Patterns to follow:**
- `biomapper2/deploy/biomapper2-api.service` for systemd service pattern
- `biomapper2/deploy/README.md` for deployment docs pattern

**Test scenarios:**
- Test expectation: none — these are configuration files, not behavioral code

**Verification:**
- Service files have correct paths, users, and restart policies
- nginx config serves static files and proxies API correctly
- .env.example documents every required variable
- README has complete deployment steps from clone to HTTPS

---

- [ ] **Unit 7: Deploy to Lightsail**

**Goal:** Deploy the app to the Lightsail instance and verify it works at `link.expertintheloop.io`.

**Requirements:** R8, R9, R10

**Dependencies:** All previous units (app verified working, tooltips added, config files created)

**Files:**
- No new files — uses deploy/ configs from Unit 6

**Approach:**
- SSH into `35.161.242.62` via `~/.ssh/lightsail-expert.pem`
- Verify biomapper2 is running on port 8001: `curl http://localhost:8001/api/v1/health`
- Verify ports 8000 and 8080 are available: `ss -tlnp | grep -E '8000|8080'`. If occupied, pick alternative ports (e.g., 8010, 8090) and update both `.env` AND the systemd service `ExecStart` lines before continuing.
- Clone the repo to a fixed path (e.g., `/home/ubuntu/biomapper-ui`) — avoid spaces in paths. The server needs git access (HTTPS clone with token, or SSH key).
- Install dependencies: `pnpm install` (must run on server — native binaries are platform-specific), `pip install -r artifacts/python-api/requirements.txt` (or use `uv`)
- **Add DNS A record early** for `link.expertintheloop.io` -> `35.161.242.62` — kick this off now so propagation happens while you build/configure. Propagation is async and typically takes a few minutes for new records.
- Build: `VITE_CLERK_PUBLISHABLE_KEY=... VITE_CLERK_PROXY_URL=https://link.expertintheloop.io/api/__clerk pnpm run build`
- **Post-build Clerk URL check**: verify the proxy URL was baked in correctly: `grep -r "link.expertintheloop.io/api/__clerk" artifacts/frontend/dist/public/ || (echo "FAIL: Clerk proxy URL not baked into build"; exit 1)`. Catches typos and missing env vars that Vite silently builds with `undefined`.
- Create `.env` file at the repo root from `.env.example` with real values
- Update systemd service file paths to match the actual clone directory, copy to `/etc/systemd/system/`, enable and start
- Verify services running locally: `curl http://localhost:8080/api/discovery/entity-types`
- Copy nginx config to `/etc/nginx/sites-available/`, symlink to `sites-enabled/`, reload nginx
- Wait for DNS propagation: `dig +short link.expertintheloop.io` until it returns `35.161.242.62`
- Run `sudo certbot --nginx -d link.expertintheloop.io` for HTTPS (requires DNS to be resolving)
- Update Clerk dashboard with new redirect URLs for `link.expertintheloop.io`
- **Note on ordering**: Clerk auth will not work until DNS + certbot + Clerk dashboard update are all complete. Test API functionality (non-auth endpoints) first, then Clerk auth last.
- Run Unit 1's verification script against localhost: `BIOMAPPER_BASE_URL=http://localhost:8001/api/v1 python verify_api.py` to confirm local API access works.

**Test scenarios:**
- Happy path: `curl https://link.expertintheloop.io/` returns the React app HTML
- Happy path: `curl https://link.expertintheloop.io/api/discovery/entity-types` returns entity types (through auth if applicable)
- Happy path: Full upload and mapping flow works through the UI at the production URL
- Happy path: SSE stream for a batch of 10+ compounds completes without gap or early termination (verifies SSE works through both nginx -> Express and Express -> FastAPI hops)
- Error path: Services auto-restart after a crash (systemd RestartSec)
- Integration: Clerk authentication works with the new domain (sign in, authorized email passes, unauthorized email blocked)

**Verification:**
- App is accessible at `https://link.expertintheloop.io`
- Upload and mapping flow produces real results
- Clerk auth works correctly
- Both systemd services are running and set to auto-start on boot

## System-Wide Impact

- **Interaction graph**: The tooltip changes and benchmark stub only affect the upload page component. No backend changes. The deployment adds nginx as a new layer between browser and Express, replicating what Replit's infrastructure does.
- **Error propagation**: No changes to error handling. The verification script (Unit 1) is standalone and doesn't affect the running app.
- **State lifecycle risks**: None — no new state, no persistence changes. The in-memory JobStore continues as-is.
- **API surface parity**: No API changes. The frontend-to-backend contract is unchanged.
- **Integration coverage**: Deployment (Unit 7) is the main integration risk — nginx must correctly proxy SSE streams (requires `X-Accel-Buffering: no` header, which the FastAPI endpoint already sets). Verify SSE streaming works through nginx.
- **Unchanged invariants**: The Python mapper service, Express proxy, and SSE streaming protocol are not modified. The batch processing flow remains per-entity with semaphore=10.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| BioMapper2 API at `biomapper.expertintheloop.io` is down or misconfigured | Unit 1 verifies this first; if it fails, all downstream work pauses until resolved |
| Port 8000 or 8080 already in use on Lightsail | Check during deployment; reassign ports in .env if needed |
| SSE streaming doesn't work through nginx | nginx config includes `proxy_http_version 1.1;`, `proxy_set_header Connection '';`, `proxy_buffering off;`, and `proxy_read_timeout 300s;`. FastAPI also sets `X-Accel-Buffering: no` per-response. |
| Clerk proxy doesn't work on new domain | Test Clerk auth early in deployment; update Clerk dashboard redirect URLs |
| DNS propagation delay for `link.expertintheloop.io` | Use direct IP access for initial testing; DNS typically propagates within minutes for new records |
| `biomapper` SDK not installable on Lightsail (dependency issues) | Verify `pip install biomapper>=1.0.0` works; the SDK is on PyPI |
| Biomapper SDK version drift between UI service and API | Pin exact biomapper version in `requirements.txt` (e.g., `biomapper==1.0.1`). Note the pin in `deploy/README.md`. Verify both ends on a known pairing at deploy time using Unit 1's verification script. |
| Express proxy drops SSE connections (Node default 2-min timeout) | Verify Express's http-proxy-middleware config preserves long-running SSE streams. Check whether `timeout` or `proxyTimeout` needs adjustment for batches > 100 names. |

## Sources & References

- **Origin document:** [docs/brainstorms/biomapper-ui-verification-and-enhancements-requirements.md](docs/brainstorms/biomapper-ui-verification-and-enhancements-requirements.md)
- Related deployment: `biomapper2/deploy/` (systemd + nginx + certbot pattern)
- Existing tooltip component: `artifacts/frontend/src/components/ui/tooltip.tsx`
- BioMapper SDK client: `/home/trentleslie/trentleslie@gmail.com/Google Drive/projects/biomapper/src/biomapper/client.py` (external project — SDK source for understanding `map_entity()` and `map_entities()`)
