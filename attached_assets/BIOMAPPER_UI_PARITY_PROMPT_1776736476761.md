# Biomapper UI — Parity with biomapper 1.0 Python Package

## Context

This project is the **Entity Linker Dashboard** — a web UI for the biomapper/BioMapper2 entity linking pipeline. It was originally built on Replit as "Biomedical-Entity-Annotator" and is now being moved to `trentleslie/biomapper-ui` on GitHub for local development and AWS deployment.

**The Python package `ddharmon` has been renamed to `biomapper` (v1.0.1 on PyPI).** All references to `ddharmon` in this codebase must be updated to `biomapper`. The import path changed: `from ddharmon import ...` → `from biomapper import ...`. The API surface is identical except `rate_limit_delay` was removed from `map_entities()` and `BioMapperClient.map_entities()`.

### What This App Is

A dashboard for running entity resolution jobs against the BioMapper2 API, visualizing results with a quality-funnel Sankey chart, and enabling human review of mappings. It is **not** the separate "Entity Mapping Validator" / expert-in-the-loop voting app (that's a different Replit project).

### What This App Is NOT

This is not the `biomapper2 - Human Review App` (the voting/validation campaign tool with inter-rater reliability). That app lives separately.

---

## Current Architecture

```
Browser → Next.js/Vite (UI) → Express (/api proxy) → FastAPI (biomapper) → BioMapper2 API
```

Two processes run side-by-side:
1. **Next.js/Vite frontend** — React UI with shadcn/ui components
2. **FastAPI Python service** (`artifacts/python-api/`) — wraps `biomapper` Python package

The frontend only talks to `/api`; Express proxies `/api/map/*` to FastAPI. SSE streams are passed through with `http-proxy` (not re-wrapped as REST) so progress events don't buffer.

`BIOMAPPER_API_KEY` lives on the Python side only — never reaches the browser.

---

## Task 1: ddharmon → biomapper Rename

### Python side (`artifacts/python-api/`)

| Find | Replace |
|------|---------|
| `from ddharmon` | `from biomapper` |
| `import ddharmon` | `import biomapper` |
| `ddharmon` in requirements/pyproject/setup files | `biomapper>=1.0.0` |
| Any `rate_limit_delay` kwargs | Remove entirely (parameter was deleted in biomapper 1.0.0) |

### Frontend side

| Find | Replace |
|------|---------|
| `ddharmon` in display text, comments, config | `biomapper` |
| API endpoint names if they reference ddharmon | Update to biomapper |

### Verification

```bash
# Should return ZERO results after rename
grep -r "ddharmon" . --include="*.py" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.json" --include="*.toml" --include="*.txt" --include="*.md" --include="*.yaml" --include="*.yml" | grep -v node_modules | grep -v .git
```

---

## Task 2: Bring UI to Full biomapper 1.0 Parity

The biomapper Python package exposes the following capabilities. The UI should surface all of them.

### biomapper Public API Surface

#### Core Mapping
| Function/Method | Description | UI Status |
|----------------|-------------|-----------|
| `map_entity(name, ...)` | Single entity lookup (sync) | Likely implemented |
| `map_entities(records, ...)` | Batch mapping via `POST /map/batch`, auto-chunked at 1000 | Implemented (batch endpoint) |
| `map_dataset_file_sync(path, ...)` | File upload mapping via `POST /map/dataset/stream` with tqdm progress | Partially implemented (SSE streaming) |
| `BioMapperClient.map_entity()` | Async single entity | Backend only |
| `BioMapperClient.map_entities()` | Async batch | Backend only |
| `BioMapperClient.map_dataset_file_iter()` | Async streaming iterator — **this is what the UI should use for live progress** | Should be wired to SSE |
| `BioMapperClient.map_dataset_file()` | Async full result (not streaming) | Backend fallback |

#### Discovery Endpoints
| Function | Description | UI Status |
|----------|-------------|-----------|
| `list_entity_types()` | Returns available entity types (e.g., `biolink:SmallMolecule`, `biolink:Protein`, `biolink:Gene`) | **Needed for entity-type dropdown** |
| `list_annotators()` | Returns available annotators (e.g., `kestrel-vector-search`) | **Needed for annotator selection** |
| `list_vocabularies()` | Returns available vocabularies (e.g., HMDB, ChEBI, RefMet, LIPIDMAPS) | **Needed for vocabulary filter checkboxes** |

#### Models
| Model | Description |
|-------|-------------|
| `MappingResult` | Per-entity result with `primary_curie`, `confidence_tier` (high/medium/low/unknown), `kg_ids`, `assigned_ids`, `error` |
| `MappingSummary` | Aggregate stats from `summarize()` |
| `DatasetMappingResult` | Container for dataset mapping: `results: list[MappingResult]`, `stream_complete: bool`, `raise_for_error()` |
| `EntityTypeInfo` | Entity type metadata |
| `AnnotatorInfo` | Annotator metadata |
| `VocabularyInfo` | Vocabulary metadata |

#### Parameters Available on All Mapping Functions
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `entity_type` | `str` | `"biolink:SmallMolecule"` | Biolink entity type |
| `annotation_mode` | `str` | `"missing"` | `"missing"` / `"all"` / `"none"` |
| `annotators` | `list[str] \| None` | `None` (all) | Specific annotators to use. `["kestrel-vector-search"]` for strict matching |
| `api_key` | `str \| None` | env var | `BIOMAPPER_API_KEY` |
| `base_url` | `str \| None` | production URL | Override for dev/staging |
| `timeout` | `float` | `30.0` | Per-request timeout |
| `progress` | `bool` | `False` | tqdm progress (sync only) |

#### Dataset-specific Parameters
| Parameter | Type | Description |
|-----------|------|-------------|
| `name_column` | `str` | Column containing entity names (required) |
| `provided_id_columns` | `list[str]` | Columns with pre-existing identifiers, e.g. `["hmdb_id"]` |
| `vocab` | `str \| None` | Vocabulary hint |
| `on_result` | callback | Per-result callback (sync path only) |
| `total_hint` | `int \| None` | Expected total for progress bar |

### Current Backend API Surface (FastAPI)

The FastAPI backend currently exposes:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `POST /api/map/batch` | POST | Accepts `{ names[], config }`, enforces 10,000-name cap, returns `job_id` |
| `GET /api/map/stream/{job_id}` | GET | Live SSE progress events until completion |
| `GET /api/map/result/{job_id}` | GET | Full results JSON once done |

Jobs are stored in-memory with 1-hour TTL. Auth failures from BioMapper2 surface as terminal job error events.

### What Needs to Be Added/Updated

#### Backend (FastAPI)

1. **Discovery endpoints** — add routes that call `list_entity_types()`, `list_annotators()`, `list_vocabularies()`:
   - `GET /api/discovery/entity-types`
   - `GET /api/discovery/annotators`
   - `GET /api/discovery/vocabularies`

2. **Pass entity_type parameter through** — the batch/stream endpoints should accept `entity_type` from the frontend and forward it to biomapper (currently hardcoded to `biolink:SmallMolecule`)

3. **Pass annotators parameter through** — allow frontend to specify which annotators to use

4. **Pass annotation_mode parameter through** — allow frontend to control annotation mode

5. **File upload endpoint** — if not already present, add `POST /api/map/dataset` that accepts file uploads and uses `map_dataset_file_iter()` for true streaming

6. **Update all `ddharmon` imports to `biomapper`**

#### Frontend (React/Next.js)

1. **Entity-type dropdown** — populated from `GET /api/discovery/entity-types`. Presets per type:
   - Small Molecule → HMDB, ChEBI, RefMet, LIPIDMAPS, PubChem
   - Protein → UniProt, NCBI Gene
   - Gene → NCBI Gene, Ensembl
   
2. **Annotator selection** — populated from `GET /api/discovery/annotators`. Allow multi-select.

3. **Annotation mode toggle** — `missing` / `all` / `none` radio or dropdown

4. **File upload support** — drag-and-drop TSV/CSV with column mapping (name_column, provided_id_columns selection)

5. **Sankey chart updates** — ensure it works across entity types:
   - Phase 1 (two-layer): Input → Resolved/Unresolved → Confidence tiers
   - Phase 2 (three-layer): adds tier → vocabulary breakdown
   - **Important:** Layer 3 must aggregate from `results[]` directly, not from `summary.vocabularyCoverage` (which doesn't give tier×vocab cross-tab)
   
6. **Color scheme consistency:**
   - Teal for resolved
   - Green/amber/orange for confidence tiers
   - Blue for vocabulary nodes

---

## Task 3: Dev API Configuration

The BioMapper2 API currently runs at `https://biomapper.expertintheloop.io/api/v1`. A dev instance will be set up on the same AWS server on a different port.

The FastAPI backend should support a `BIOMAPPER_BASE_URL` environment variable (or similar) that overrides the default `BioMapperClient` base URL. This enables:
- **Production:** Points to `https://biomapper.expertintheloop.io/api/v1`
- **Dev:** Points to `http://localhost:<dev-port>/api/v1` (or the dev instance URL)

The `BioMapperClient` already supports `base_url` as a constructor parameter. Wire this through from an env var in the FastAPI startup.

---

## Deployment Plan

### Current: Replit
- Two-process setup (Next.js + FastAPI)
- PostgreSQL on Replit (for the other validator app — this app uses in-memory job storage)

### Target: AWS
- Same two-process architecture
- Run alongside the biomapper2 API on the existing AWS instance
- GitHub repo: `trentleslie/biomapper-ui`

### Environment Variables Needed
```
BIOMAPPER_API_KEY=<key>
BIOMAPPER_BASE_URL=https://biomapper.expertintheloop.io/api/v1  # or dev URL
NODE_ENV=production
PORT=<frontend-port>
PYTHON_API_PORT=<fastapi-port>
```

---

## Priority Order

1. **ddharmon → biomapper rename** (prerequisite for everything)
2. **Discovery endpoints** (entity-types, annotators, vocabularies) — enables the UI to be dynamic instead of hardcoded
3. **Entity-type dropdown + annotator selection** in frontend
4. **File upload with column mapping** if not already present
5. **Sankey Phase 2→3** (tier × vocab cross-tab)
6. **Dev API base_url configuration**
7. **AWS deployment setup**

---

## Reference Files

- **biomapper Python package:** `~/trentleslie@gmail.com/Google Drive/projects/biomapper/`
- **API requirements roadmap:** `~/.claude/plans/ddharmon-full-api-coverage-requirements.md`
- **biomapper2 API docs:** `https://biomapper.expertintheloop.io/api/v1/docs` (Swagger UI)
- **Verification results:** `~/trentleslie@gmail.com/Google Drive/projects/biovector-eval/notebooks/verification/`
- **Original Claude chat for Replit build:** `https://claude.ai/chat/845add9e-d471-488f-bb35-e57528a02fb8`

## Naming Reference

| Name | What It Is |
|------|-----------|
| **biomapper** (PyPI) | Python client package, v1.0.1 (`pip install biomapper`) |
| **biomapper2** | The backend API service at expertintheloop.io |
| **biomapper-ui** | This project — the Entity Linker Dashboard |
| **biomapper2 - Human Review App** | Separate project — voting/validation campaigns (NOT this) |
