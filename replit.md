# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5 (TypeScript) — public-facing at `/api`
- **Python API**: FastAPI + uvicorn — internal entity linking service at port 8000
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Architecture

```
Browser → Express (/api) → FastAPI Python (:8000) → BioMapper2 API
```

- The Express API server (`artifacts/api-server`) is the public entrypoint at `/api`
- `/api/map/*` requests are proxied (unbuffered) to the FastAPI Python service via `http-proxy-middleware`
- The proxy is mounted BEFORE body parsers in `app.ts` to preserve the raw request body stream
- The Python FastAPI service (`artifacts/python-api`) uses `ddharmon` v0.2.0 to call BioMapper2
- SSE streams from FastAPI flow through the proxy without buffering (`X-Accel-Buffering: no`)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run Express API server locally

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/healthz` | Health check |
| POST | `/api/map/batch` | Start mapping job (max 10,000 names) → `{job_id}` |
| GET | `/api/map/stream/{job_id}` | SSE stream of job progress |
| GET | `/api/map/result/{job_id}` | Full results for completed job |

## Environment Variables

- `BIOMAPPER_API_KEY` — Required by `ddharmon`/BioMapper2 (read automatically by `BioMapperClient`)
- `PYTHON_API_PORT` — Port for Python FastAPI service (default: 8000)
- `PORT` — Port for Express API server (default: 8080 in production)

## Workflows

- `artifacts/api-server: API Server` — Express API server on port 8080
- `Entity Linker Python API` — FastAPI service on port 8000
- `artifacts/mockup-sandbox: Component Preview Server` — UI mockup sandbox

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
