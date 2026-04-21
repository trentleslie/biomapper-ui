# Entity Linker Dashboard

## Overview

PhenomeHealth Entity Linking Dashboard — a scientific tool for metabolomics researchers to map raw compound names to biological ontologies (BioMapper2 via the `biomapper` Python package, v1.0.1).

pnpm workspace monorepo, TypeScript + Python.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **Frontend**: React + Vite (port 18130, served at `/`)
- **API framework**: Express 5 (TypeScript) — public-facing at `/api` (port 8080)
- **Python API**: FastAPI + uvicorn — internal entity linking service at port 8000
- **Auth**: Clerk (Google OAuth, `@phenomehealth.org` domain restriction)
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Architecture

```
Browser → React Frontend (/) → Express (/api) → FastAPI Python (:8000) → BioMapper2 API
```

- The React frontend (`artifacts/frontend`) is the main UI at `/`
- The Express API server (`artifacts/api-server`) is the public entrypoint at `/api`
- `/api/map/*` requests are proxied (unbuffered) to the FastAPI Python service via `http-proxy-middleware`
- The proxy is mounted BEFORE body parsers in `app.ts` to preserve the raw request body stream
- The Python FastAPI service (`artifacts/python-api`) uses `biomapper` v1.0+ to call BioMapper2
- SSE streams from FastAPI flow through the proxy without buffering (`X-Accel-Buffering: no`)
- Clerk middleware is mounted in `app.ts` for server-side auth validation
- Clerk proxy middleware (`clerkProxyMiddleware.ts`) is active in production only

## Frontend Routes

| Route | Auth | Description |
|-------|------|-------------|
| `/` | Public | Landing page; authenticated users redirect to `/upload` |
| `/sign-in` | Public | Clerk sign-in (Google OAuth) |
| `/sign-up` | Public | Clerk sign-up (domain-restricted to @phenomehealth.org) |
| `/upload` | Protected | File upload workflow (CSV/XLSX/TSV) + mapping configuration |
| `/dashboard/:jobId` | Protected | Live SSE streaming dashboard + results + charts + downloads |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/healthz` | Health check |
| POST | `/api/map/batch` | Start mapping job (max 10,000 names) → `{job_id}` |
| GET | `/api/map/stream/{job_id}` | SSE stream of job progress (`text/event-stream`) |
| GET | `/api/map/result/{job_id}` | Full results for completed job |
| GET | `/api/discovery/entity-types` | List Biolink entity types from BioMapper2 (cached) |
| GET | `/api/discovery/annotators` | List available annotators from BioMapper2 (cached) |
| GET | `/api/discovery/vocabularies` | List supported vocabularies from BioMapper2 (cached) |

## Key Files

- `artifacts/frontend/src/App.tsx` — ClerkProvider + WouterRouter + all routes
- `artifacts/frontend/src/pages/upload.tsx` — File upload, column detection, job submit
- `artifacts/frontend/src/pages/dashboard.tsx` — SSE progress, Sankey, charts, results table
- `artifacts/frontend/src/hooks/use-mapping-stream.ts` — EventSource SSE hook
- `artifacts/frontend/src/components/SankeyChart.tsx` — @nivo/sankey quality funnel
- `artifacts/frontend/src/lib/sankey.ts` — buildSankeyData() helper
- `artifacts/frontend/src/types/mapping.ts` — MappingSummary, MappingResult types
- `artifacts/api-server/src/app.ts` — Express app (Clerk + map proxy)
- `artifacts/api-server/src/middlewares/clerkProxyMiddleware.ts` — Clerk FAPI proxy (prod only)
- `artifacts/python-api/main.py` — FastAPI app
- `artifacts/python-api/services/mapper.py` — biomapper integration
- `lib/api-spec/openapi.yaml` — OpenAPI spec
- `lib/api-client-react/src/generated/api.ts` — Orval-generated React hooks

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks from OpenAPI spec
- `pnpm --filter @workspace/api-server run dev` — run Express API server locally

## Environment Variables

- `VITE_CLERK_PUBLISHABLE_KEY` — Clerk publishable key (set automatically via Replit auth)
- `CLERK_SECRET_KEY` — Clerk secret key (server-side, prod only)
- `VITE_CLERK_PROXY_URL` — Clerk proxy URL (set automatically in production)
- `PYTHON_API_PORT` — Port for Python FastAPI (default: 8000)
- `BIOMAPPER_API_KEY` — API key for BioMapper2 (required for live mapping)
- `BIOMAPPER_BASE_URL` — Optional override for the BioMapper2 base URL; when unset the biomapper SDK default applies. Resolved value is logged at startup.

## Auth Domain Restriction

After sign-in, the frontend checks `user.primaryEmailAddress` for domain:
- `@phenomehealth.org` ✓
- `@phenome.health` ✓
- `@phenomics.ai` ✓
- Other domains → AccessDeniedPage + signOut()

## Development Notes

- The standalone "Entity Linker Python API" workflow handles the Python API in development
- The artifact.toml secondary service for the Python API handles production deployment
- Port 8000 conflict in dev between standalone workflow and artifact secondary service is expected and harmless
- SSE streaming uses native `EventSource` API (not the Orval-generated hook)
- The Sankey chart uses `buildSankeyData()` with a `Math.max(value, 1)` guard for zero-value links
