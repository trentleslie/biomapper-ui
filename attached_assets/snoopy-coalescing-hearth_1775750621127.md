# Web App Entity Linking Reporting Plan

## Current State: Metabolon Mapping Reporting Analysis

### Overview

The metabolon mapping work demonstrates a mature reporting pipeline for entity linking via ddharmon + biomapper. Here's what currently exists:

### Output Formats

| Format | Location | Purpose |
|--------|----------|---------|
| **JSON** | `data/metabolon/processed/*.json` | Structured results with full metadata, ablation studies, summary stats |
| **TSV** | `data/review/*.tsv` | Flat format for manual expert review |
| **Markdown** | `data/review/*.md` | Executive summaries with resolution rates, unresolved analysis |

### Key Metrics Tracked

1. **Resolution Rate**: % of names with any mapping (misleading - UMLS fallback inflates this to 99%+)
2. **High-Quality Rate**: % with confidence tier "high" or "medium" (more meaningful - currently 28%)
3. **Confidence Tier Distribution**: high/medium/low/unknown breakdown
4. **Vocabulary Coverage**: Which ontologies appear (HMDB, ChEBI, RefMet, PubChem, UMLS, etc.)
5. **Match Level Stats**: Resolution rates by input quality (MS2: 92.6%, CURATION: 98.5%, MS1: 98.6%)
6. **Needs Review Flag**: Records requiring manual validation

### Data Structures

**ddharmon Result Record**:
```json
{
  "feature_id": "...",
  "original_name": "L-Alanine",
  "matched_name": "L-Alanine",
  "match_level": "MS2",
  "resolved": true,
  "primary_curie": "HMDB:HMDB0000161",
  "confidence_score": 0.95,
  "confidence_tier": "high",
  "needs_review": false,
  "hmdb_ids": ["HMDB0000161"],
  "kegg_ids": ["C00041"],
  "chebi_ids": ["CHEBI:16977"],
  "refmet_ids": ["REFMET:000123"],
  "lipidmaps_ids": []
}
```

**Summary Stats Block**:
```json
{
  "total_features": 2221,
  "unique_names_queried": 1267,
  "normalized": 1260,
  "normalization_rate": 0.9945,
  "high_quality_rate": 0.2802,
  "confidence_tier_distribution": {
    "high": 316,
    "medium": 39,
    "low": 400,
    "unknown": 512
  },
  "vocabulary_coverage": {
    "refmet_id": 274,
    "CHEBI": 250,
    "PUBCHEM.COMPOUND": 136
  }
}
```

### Workflow Steps (Notebook-based)

1. Load raw data (XLSX/CSV with compound names)
2. Clean/preprocess names
3. Deduplicate by name (2,221 features → 1,267 unique names)
4. Async batch mapping via ddharmon → BioMapper2 API
5. Extract cross-references (HMDB, ChEBI, RefMet, etc.)
6. Generate summary statistics
7. Export JSON (structured) + TSV (flat) + Markdown (report)

### Ablation Capability

Current notebooks support annotator ablation studies:
- `default`: All annotators (RefMet + Kestrel)
- `refmet_only`: Only RefMet annotator
- `kestrel_only`: Only Kestrel annotator

This helps understand which backend pathway contributes what.

---

## Web App Design: Entity Linking Dashboard

### User Flow

```
┌─────────────────────────────────────────────────────────────────┐
│  1. UPLOAD                                                       │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  Drag & drop file (CSV, TSV, XLSX)                          │ │
│  │  or click to browse                                          │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                              ↓                                   │
│  2. CONFIGURE                                                    │
│  ┌─────────────┐  ┌─────────────────┐  ┌──────────────────────┐ │
│  │ Name Column │  │ Target Ontologies│  │ Quality Settings    │ │
│  │ [dropdown]  │  │ ☑ HMDB          │  │ Annotators: [All▾]  │ │
│  │             │  │ ☑ ChEBI         │  │ Mode: [Missing▾]    │ │
│  │             │  │ ☑ PubChem       │  │ Min confidence: [-] │ │
│  │             │  │ ☑ RefMet        │  │                     │ │
│  │             │  │ ☐ LIPIDMAPS     │  │                     │ │
│  └─────────────┘  └─────────────────┘  └──────────────────────┘ │
│                              ↓                                   │
│  3. PROCESS → [Run Mapping]                                      │
│                              ↓                                   │
│  4. DASHBOARD (live stats during/after processing)              │
└─────────────────────────────────────────────────────────────────┘
```

### Configuration Options

**MVP file size limit:** 10,000 names max per job. Validate in FastAPI endpoint and return 400 if exceeded. (Reference: Metabolon dataset has ~1,267 unique names)

| Setting | Options | Default | Source |
|---------|---------|---------|--------|
| **Name Column** | Auto-detected or manual select | First text column | User file |
| **Target Ontologies** | HMDB, ChEBI, PubChem, RefMet, LIPIDMAPS, UMLS, KEGG, MESH, UNII, ChEMBL | All checked | API returns all; filter on display |
| **Annotators** | All (default), RefMet-only, Kestrel-only | All | ddharmon `annotators` param |
| **Annotation Mode** | Missing, All, None | Missing | ddharmon `annotation_mode` param |
| **Confidence Filter** | Show all, High+Medium only, High only | Show all | Post-process filter |
| **Hint Column** (optional) | Column with existing HMDB IDs | None | User file |

### Dashboard Components

#### A. Summary Cards (Top Row)
```
┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌───────────────┐
│ Total Rows    │ │ Unique Names  │ │ Resolved      │ │ High Quality  │
│    2,221      │ │    1,267      │ │   99.4%       │ │    28.0%      │
│               │ │ (deduplicated)│ │ (any match)   │ │ (high+medium) │
└───────────────┘ └───────────────┘ └───────────────┘ └───────────────┘
```

#### B. Confidence Distribution (Pie/Donut Chart)
- High (green): 316 (24.9%)
- Medium (yellow): 39 (3.1%)
- Low (orange): 400 (31.6%)
- Unknown (gray): 512 (40.4%)

#### C. Vocabulary Coverage (Bar Chart)
- HMDB: 512 hits
- RefMet: 274 hits
- ChEBI: 250 hits
- PubChem: 136 hits
- UMLS: 84 hits
- etc.

#### D. Quality Funnel — Primary Visualization (Sankey Diagram)

**Library:** `@nivo/sankey` — install: `npm install @nivo/sankey @nivo/core`

**Component:** `frontend/components/SankeyChart.tsx`
**Helper:** `frontend/lib/sankey.ts`

The Sankey is the primary reporting visualization. It shows the complete quality
funnel from raw input names through to vocabulary assignments in a single diagram.

**Two-layer MVP (Phase 1):**
```
Input Names (1,267) → Resolved (1,260) / Unresolved (7)
Resolved → High (316) / Medium (39) / Low (400) / Unknown (512)
```

**Three-layer full (Phase 2, after vocabulary layer is validated):**
```
Input Names → Resolved / Unresolved
Resolved → High / Medium / Low / Unknown
High + Medium → HMDB / ChEBI / RefMet / PubChem / ...
```

**IMPORTANT — layer 3 data source:** `MappingSummary.vocabularyCoverage` only
contains total hits per vocabulary, not broken down by confidence tier. Layer 3
must be aggregated from `results[]` directly, not from summary stats.

**Node color scheme (use consistently throughout dashboard):**
- Input: gray (#6b7280)
- Resolved: teal (#14b8a6)
- Unresolved: red (#ef4444)
- High confidence: green (#22c55e)
- Medium confidence: amber (#f59e0b)
- Low confidence: orange (#f97316)
- Unknown: gray (#9ca3af)
- Vocabulary nodes: blue (#3b82f6)

**Data transformation (frontend/lib/sankey.ts):**

```typescript
import { MappingResult, MappingSummary } from '../types/mapping';

export interface SankeyNode {
  id: string;
  label?: string;
  color?: string;
}

export interface SankeyLink {
  source: string;
  target: string;
  value: number;
}

export interface SankeyData {
  nodes: SankeyNode[];
  links: SankeyLink[];
}

const TIER_COLORS = {
  high:    '#22c55e',  // green
  medium:  '#f59e0b',  // amber
  low:     '#f97316',  // orange
  unknown: '#9ca3af',  // gray
};

export function buildSankeyData(
  summary: MappingSummary,
  results: MappingResult[],
  includeVocabLayer: boolean = false
): SankeyData {
  const unresolved = summary.uniqueNames - summary.resolved;
  // NOTE: rename 'unknown' on destructure — reserved keyword in TypeScript
  const { high, medium, low, unknown: unknownCount } = summary.confidenceTierDistribution;

  // Always include two-layer nodes
  const nodes: SankeyNode[] = [
    { id: 'input',      label: `Input (${summary.uniqueNames})`,   color: '#6b7280' },
    { id: 'resolved',   label: `Resolved (${summary.resolved})`,   color: '#14b8a6' },
    { id: 'unresolved', label: `Unresolved (${unresolved})`,       color: '#ef4444' },
    { id: 'high',       label: `High (${high})`,                   color: TIER_COLORS.high },
    { id: 'medium',     label: `Medium (${medium})`,               color: TIER_COLORS.medium },
    { id: 'low',        label: `Low (${low})`,                     color: TIER_COLORS.low },
    { id: 'unknown_tier', label: `Unknown (${unknownCount})`,      color: TIER_COLORS.unknown },
  ];

  const links: SankeyLink[] = [
    // Layer 1: resolution
    { source: 'input',    target: 'resolved',     value: summary.resolved },
    { source: 'input',    target: 'unresolved',   value: Math.max(unresolved, 1) }, // nivo requires value > 0
    // Layer 2: confidence tiers (from resolved only)
    { source: 'resolved', target: 'high',         value: high || 1 },
    { source: 'resolved', target: 'medium',       value: medium || 1 },
    { source: 'resolved', target: 'low',          value: low || 1 },
    { source: 'resolved', target: 'unknown_tier', value: unknownCount || 1 },
  ];

  // Layer 3: vocabulary breakdown (Phase 2)
  // Requires aggregation from results[], NOT from summary.vocabularyCoverage
  if (includeVocabLayer && results.length > 0) {
    // Count vocab hits per confidence tier
    const vocabByTier: Record<string, Record<string, number>> = {};

    for (const result of results) {
      if (!result.resolved) continue;
      const tier = result.confidenceTier;
      // Only show top vocabs for high+medium to keep diagram readable
      if (tier !== 'high' && tier !== 'medium') continue;

      for (const [vocab, ids] of Object.entries(result.identifiers)) {
        if (!ids || ids.length === 0) continue;
        if (!vocabByTier[tier]) vocabByTier[tier] = {};
        vocabByTier[tier][vocab] = (vocabByTier[tier][vocab] || 0) + 1;
      }
    }

    // Add vocab nodes + links (top 5 vocabs by total hits)
    const vocabTotals: Record<string, number> = {};
    for (const tierCounts of Object.values(vocabByTier)) {
      for (const [vocab, count] of Object.entries(tierCounts)) {
        vocabTotals[vocab] = (vocabTotals[vocab] || 0) + count;
      }
    }
    const topVocabs = Object.entries(vocabTotals)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([vocab]) => vocab);

    for (const vocab of topVocabs) {
      nodes.push({ id: `vocab_${vocab}`, label: vocab, color: '#3b82f6' });
    }
    for (const [tier, counts] of Object.entries(vocabByTier)) {
      const tierId = tier === 'unknown' ? 'unknown_tier' : tier;
      for (const [vocab, count] of Object.entries(counts)) {
        if (!topVocabs.includes(vocab)) continue;
        links.push({ source: tierId, target: `vocab_${vocab}`, value: count });
      }
    }
  }

  return { nodes, links };
}
```

**Component (frontend/components/SankeyChart.tsx):**

```typescript
import { ResponsiveSankey } from '@nivo/sankey';
import { buildSankeyData } from '../lib/sankey';
import { MappingResult, MappingSummary } from '../types/mapping';

interface SankeyChartProps {
  summary: MappingSummary;
  results: MappingResult[];
  includeVocabLayer?: boolean;
}

export function SankeyChart({ summary, results, includeVocabLayer = false }: SankeyChartProps) {
  const data = buildSankeyData(summary, results, includeVocabLayer);

  return (
    <div style={{ height: 400 }}>
      <ResponsiveSankey
        data={data}
        margin={{ top: 20, right: 160, bottom: 20, left: 20 }}
        align="justify"
        colors={({ id }) => data.nodes.find(n => n.id === id)?.color || '#6b7280'}
        nodeOpacity={1}
        nodeThickness={18}
        nodeInnerPadding={3}
        nodeSpacing={24}
        nodeBorderWidth={0}
        linkOpacity={0.4}
        linkHoverOpacity={0.7}
        enableLinkGradient={true}
        labelPosition="outside"
        labelOrientation="horizontal"
        labelPadding={16}
        labelTextColor={{ from: 'color', modifiers: [['darker', 1]] }}
      />
    </div>
  );
}
```

**nivo zero-value guard:** `@nivo/sankey` will throw if any link has `value: 0`. The
`buildSankeyData` function uses `Math.max(value, 1)` as a guard. This means a dataset
with zero unresolved names will still show a thin unresolved link — acceptable for MVP.

#### E. Needs Review Table (Interactive)
| Original Name | Matched Name | Confidence | Reason | Action |
|--------------|--------------|------------|--------|--------|
| ZINC000012345 | - | - | No match | [Flag] |
| 4-HO-MET | 4-Hydroxy-N-methyl... | low | Fuzzy match | [Review] |

#### F. Results Table (Paginated, Sortable, Filterable)
- All mapped rows with selected vocabulary columns
- Click to expand → full cross-reference details
- Filter by confidence tier
- Search by name

### Output Downloads

| Format | Contents | Use Case |
|--------|----------|----------|
| **JSON** | Full structured results + summary + metadata | Programmatic use, archival |
| **TSV** | Flat table with selected ID columns | Spreadsheet review |
| **Markdown/HTML Report** | Summary stats + charts + unresolved analysis | Sharing/documentation |

### Technical Stack

| Component | Choice | Notes |
|-----------|--------|-------|
| **Frontend** | Next.js + React | UI only, no direct BioMapper2 calls |
| **Backend** | FastAPI (Python) | Hosts ddharmon, calls BioMapper2 |
| **Auth** | NextAuth + Google OAuth | Domain + individual email whitelist |
| **Charts** | Recharts + `@nivo/sankey` | Recharts for pie/bar; nivo for primary Sankey funnel |
| **File Upload** | react-dropzone | Drag & drop, parse in browser, POST names to FastAPI |
| **Progress** | SSE (Server-Sent Events) | FastAPI `StreamingResponse` with `text/event-stream` |
| **Deployment** | AWS (expertintheloop.io subdomain) | NOT Replit-hosted in production |

### Architecture (Critical - Follow Exactly)

```
┌─────────────┐      ┌─────────────────┐      ┌────────────┐      ┌─────────────┐
│   Browser   │ ──→  │  Next.js :3000  │ ──→  │ FastAPI    │ ──→  │ BioMapper2  │
│  (React UI) │      │  (UI + Proxy)   │      │ :8000      │      │ API         │
└─────────────┘      └─────────────────┘      │ (ddharmon) │      └─────────────┘
                                              └────────────┘
```

**Data Flow:**
1. User uploads CSV/XLSX → Browser parses file (SheetJS/Papa Parse)
2. Browser extracts name column → POSTs `{names: [...], config: {...}}` to Next.js `/api/map`
3. Next.js proxies to FastAPI `POST /map/batch`
4. FastAPI instantiates ddharmon, calls BioMapper2 in batches
5. FastAPI streams progress via SSE to `GET /map/stream/{job_id}`
6. Next.js proxies SSE stream to browser
7. Browser updates progress bar + results table in real-time

### Mapping from Notebook to Dashboard

| Notebook Cell | Dashboard Component |
|---------------|---------------------|
| Summary stats dict | Summary Cards |
| `confidence_tier_distribution` | Confidence Distribution chart |
| `vocabulary_coverage` | Vocabulary Coverage chart |
| Ablation comparison | Optional: Annotator comparison tab |
| Unresolved analysis | Needs Review table |
| Final mappings list | Results Table |
| JSON/TSV export | Download buttons |

---

## FastAPI Backend Specification

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/map/batch` | Start a mapping job, returns `job_id` |
| `GET` | `/map/stream/{job_id}` | SSE stream of progress + results |
| `GET` | `/map/result/{job_id}` | Full results (after job complete) |
| `GET` | `/health` | Health check |

### Backend Code Structure

```python
# backend/main.py
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routes import map, health

app = FastAPI(title="Entity Linker API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],  # Next.js dev
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(map.router, prefix="/map")
app.include_router(health.router)
```

```python
# backend/routes/map.py
from fastapi import APIRouter, BackgroundTasks
from fastapi.responses import StreamingResponse
from services.mapper import MapperService
from services.jobs import job_store
from models.schemas import BatchRequest, JobStatus
import uuid
import asyncio

router = APIRouter()

@router.post("/batch")
async def start_batch(request: BatchRequest, background_tasks: BackgroundTasks):
    job_id = str(uuid.uuid4())
    job_store.create(job_id, total=len(request.names))
    background_tasks.add_task(run_mapping, job_id, request)
    return {"job_id": job_id}

@router.get("/stream/{job_id}")
async def stream_progress(job_id: str):
    async def event_generator():
        while True:
            job = job_store.get(job_id)
            if job is None:
                yield f"event: error\ndata: Job not found\n\n"
                break

            yield f"event: progress\ndata: {job.to_json()}\n\n"

            if job.status in ("complete", "error"):
                break

            await asyncio.sleep(0.5)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"}
    )

async def run_mapping(job_id: str, request: BatchRequest):
    mapper = MapperService()
    try:
        async for result in mapper.map_batch(request.names, request.config):
            job_store.add_result(job_id, result)
        job_store.complete(job_id)
    except Exception as e:
        job_store.error(job_id, str(e))
```

```python
# backend/services/mapper.py
import os
import asyncio
from ddharmon import BioMapperClient
from typing import AsyncIterator
from models.schemas import MappingConfig

# NOTE: Verify the actual ddharmon class name, constructor signature, and result
# access patterns (e.g., result.ids_for("HMDB")) from the published PyPI package
# before scaffolding this file. The API surface below is inferred from notebook usage.

class MapperService:
    def __init__(self):
        self.client = BioMapperClient(
            api_key=os.environ.get("BIOMAPPER_API_KEY"),
            base_url="https://biomapper2.kestrel.tripl.bio/api/v1"
        )
        self.semaphore = asyncio.Semaphore(10)  # Max 10 concurrent requests

    async def map_batch(
        self,
        names: list[str],
        config: MappingConfig  # NOT dict — use Pydantic model from models.schemas
    ) -> AsyncIterator[dict]:
        """Process names with bounded concurrency, yield results as they complete."""
        queue = asyncio.Queue()

        async def process_one(name: str):
            async with self.semaphore:
                try:
                    result = await self.client.map_entity(
                        name=name,
                        entity_type="biolink:SmallMolecule",
                        annotation_mode=config.annotation_mode,  # Pydantic attribute access
                        identifiers=config.hints.get(name, {})   # hints is a dict
                    )
                    await queue.put(self._process_result(name, result))
                except Exception as e:
                    await queue.put({"name": name, "error": str(e), "resolved": False})

        # Start all tasks (bounded by semaphore)
        tasks = [asyncio.create_task(process_one(name)) for name in names]

        # Yield results as they arrive
        for _ in range(len(names)):
            result = await queue.get()
            yield result

        # Ensure all tasks complete
        await asyncio.gather(*tasks)

    def _process_result(self, name: str, result) -> dict:
        return {
            "name": name,
            "resolved": result.resolved,
            "primary_curie": result.primary_curie,
            "confidence_score": result.confidence_score,
            "confidence_tier": self._get_tier(result.confidence_score),
            "identifiers": {
                "hmdb": result.ids_for("HMDB"),
                "chebi": result.ids_for("CHEBI"),
                "pubchem": result.ids_for("PUBCHEM.COMPOUND"),
                "refmet": result.ids_for("refmet_id"),
                "lipidmaps": result.ids_for("LIPIDMAPS"),
            }
        }

    @staticmethod
    def _get_tier(score: float | None) -> str:
        # NOTE: confidence_score is UNBOUNDED (not 0-1)
        # Typical range: 0-5+, derived from semantic similarity
        if score is None:
            return "unknown"
        if score >= 2.0:
            return "high"
        if score >= 1.0:
            return "medium"
        return "low"
```

```python
# backend/models/schemas.py
from pydantic import BaseModel
from typing import Literal

class MappingConfig(BaseModel):
    annotation_mode: Literal["missing", "all", "none"] = "missing"
    hints: dict[str, dict[str, str | list[str]]] = {}  # name -> {vocab: id(s)}

class BatchRequest(BaseModel):
    names: list[str]  # MVP limit: 10,000 names max (validate in endpoint)
    config: MappingConfig = MappingConfig()

class JobStatus(BaseModel):
    job_id: str
    status: Literal["pending", "processing", "complete", "error"]
    completed: int
    total: int
    error_count: int
    results: list[dict] = []
```

---

## BioMapper2 API Reference

**NOTE:** The frontend does NOT call BioMapper2 directly. FastAPI (via ddharmon) is the only caller.

### API Endpoint

```
POST https://biomapper2.kestrel.tripl.bio/api/v1/map/entity
```

### Request Format

```json
{
  "name": "L-Alanine",
  "entity_type": "biolink:SmallMolecule",
  "annotation_mode": "missing",
  "identifiers": {}
}
```

**With hint (optional):**
```json
{
  "name": "4,6-DIOXOHEPTANOIC ACID",
  "entity_type": "biolink:SmallMolecule",
  "annotation_mode": "missing",
  "identifiers": {
    "HMDB": "HMDB0003349"
  }
}
```

### Response Format

```json
{
  "query_name": "L-Alanine",
  "resolved": true,
  "primary_curie": "RM:0000108",
  "chosen_kg_id": "RM:0000108",
  "confidence_score": 2.5,
  "identifiers": {
    "HMDB": ["HMDB0000161"],
    "CHEBI": ["16977"],
    "PUBCHEM.COMPOUND": ["5950"],
    "refmet_id": ["RM0000108"],
    "KEGG.COMPOUND": ["C00041"]
  },
  "error": null
}
```

### Key Parameters

| Parameter | Type | Values | Description |
|-----------|------|--------|-------------|
| `entity_type` | string | `biolink:SmallMolecule` | Always use this for metabolites |
| `annotation_mode` | string | `missing`, `all`, `none` | When to query external DBs |
| `identifiers` | object | `{VOCAB: [IDs]}` | Hints for resolver |

### Confidence Tier Derivation

The API returns `confidence_score` (float). Derive tiers in FastAPI backend:

**IMPORTANT:** The confidence score is **UNBOUNDED** (not 0-1). Typical range is 0-5+, derived from semantic similarity. Do NOT normalize or treat as a percentage.

```python
# In FastAPI backend (services/mapper.py)
def get_confidence_tier(score: float | None) -> str:
    if score is None:
        return "unknown"
    if score >= 2.0:
        return "high"    # Strong semantic match
    if score >= 1.0:
        return "medium"  # Decent match, worth reviewing
    return "low"         # Fuzzy/fallback match
```

Example scores from Metabolon data:
- `4.82` → high (exact chemical name match)
- `2.47` → high (good synonym match)
- `0.85` → low (UMLS fuzzy fallback)
- `null` → unknown (HMDB hint pass-through)

### Rate Limiting

- No server-side rate limiting documented
- Recommend client-side: 10 concurrent requests max
- Timeout: 30 seconds per request

### Batch Processing Pattern

Batch processing happens in **FastAPI backend only**. See `backend/services/mapper.py` above for the implementation.

Frontend consumes progress via SSE:

```typescript
// frontend/lib/useMapProgress.ts - SSE consumer hook
// (See full implementation in Error Handling section)
```

---

## Implementation Phases (For Replit Agent)

### Phase 1: Core MVP
1. **FastAPI backend** with ddharmon integration (routes: `/map/batch`, `/map/stream/{job_id}`)
2. **Next.js frontend** with Google OAuth (phenomehealth.org domain restriction)
3. Next.js proxy rewrites to FastAPI (`/api/backend/*` → `:8000`)
4. File upload (react-dropzone) with browser-side CSV/XLSX parsing
5. Configuration panel (name column dropdown, target ontologies checkboxes)
6. SSE progress streaming (FastAPI `StreamingResponse` → Next.js proxy → browser)
7. Summary cards (total rows, unique names, resolved %, high-quality %)
8. **Sankey quality funnel** — two layers (input → resolution → confidence tier)
   using `@nivo/sankey` + `buildSankeyData()` from `lib/sankey.ts`
9. Results table with pagination and sorting
10. TSV download

### Phase 2: Dashboard Enhancements
1. Vocabulary coverage horizontal bar chart (Recharts)
2. Confidence distribution pie/donut chart (Recharts, optional companion to Sankey)
3. **Sankey layer 3** — vocabulary breakdown from high+medium confidence tiers
   (requires aggregation from `results[]`, not `summary.vocabularyCoverage`)
4. Needs review table with expandable details
5. JSON + Markdown report downloads

### Phase 3: Advanced Features
1. Hint column support (existing HMDB IDs from user file)
2. Annotation mode toggle (missing/all/none)
3. Confidence threshold slider (filter results)
4. Export customization (select which ID columns to include)
5. Save/load job history
6. **Persistent job store** (Redis) for production scaling - in-memory is fine for MVP/personal use

---

## Project Structure (Full Stack)

```
entity-linker/
├── frontend/                 # Next.js app
│   ├── app/
│   │   ├── page.tsx              # Landing / upload page
│   │   ├── dashboard/
│   │   │   └── page.tsx          # Main dashboard view
│   │   └── api/
│   │       └── auth/[...nextauth]/route.ts   # Google OAuth only
│   ├── components/
│   │   ├── SankeyChart.tsx       # PRIMARY: quality funnel (@nivo/sankey)
│   │   ├── FileUpload.tsx        # Drag & drop
│   │   ├── ConfigPanel.tsx       # Settings form
│   │   ├── SummaryCards.tsx      # Stats cards
│   │   ├── ConfidenceChart.tsx   # Pie chart (secondary)
│   │   ├── VocabCoverage.tsx     # Bar chart
│   │   ├── ResultsTable.tsx      # Paginated table
│   │   └── ProgressBar.tsx       # Live progress (SSE consumer)
│   ├── lib/
│   │   ├── sankey.ts             # buildSankeyData() transformation
│   │   ├── parser.ts             # CSV/TSV/XLSX parsing (browser-side)
│   │   └── reports.ts            # Export generation (JSON/TSV/MD)
│   ├── types/
│   │   └── mapping.ts            # TypeScript interfaces
│   └── next.config.js            # MUST include proxy rewrites
│
├── backend/                  # FastAPI app
│   ├── main.py                   # FastAPI app, CORS, routes
│   ├── routes/
│   │   ├── map.py                # POST /map/batch, GET /map/stream/{job_id}
│   │   └── health.py             # GET /health
│   ├── services/
│   │   ├── mapper.py             # ddharmon wrapper, concurrent batch processing
│   │   └── jobs.py               # In-memory job store (MVP); add 1-hour TTL cleanup to prevent memory leaks
│   ├── models/
│   │   └── schemas.py            # Pydantic models
│   └── requirements.txt          # ddharmon, fastapi, uvicorn
│
├── .replit                   # Process orchestration (dev only)
├── Procfile                  # For production deployment
└── .env.example              # Environment variables template
```

### Next.js Proxy Configuration (REQUIRED)

```javascript
// frontend/next.config.js
/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/backend/:path*',
        destination: 'http://localhost:8000/:path*',
      },
    ];
  },
};

module.exports = nextConfig;
```

**Why:** Browser cannot call FastAPI directly due to CORS. Next.js proxies `/api/backend/*` → FastAPI.

**IMPORTANT for SSE:** Do NOT add a Next.js API route wrapper around the SSE stream — use the rewrite proxy directly. Adding an intermediate API route will buffer the response and break real-time streaming.

### Replit Process Orchestration (Dev Only)

```toml
# .replit
run = "npm run dev:all"

[nix]
channel = "stable-24_05"

[[ports]]
localPort = 3000
externalPort = 80

[[ports]]
localPort = 8000
externalPort = 8000
```

```json
// package.json (root)
{
  "scripts": {
    "dev:frontend": "cd frontend && npm run dev",
    "dev:backend": "cd backend && uvicorn main:app --reload --port 8000",
    "dev:all": "concurrently \"npm run dev:frontend\" \"npm run dev:backend\""
  },
  "devDependencies": {
    "concurrently": "^8.0.0"
  }
}
```

### Production Deployment (AWS)

```
# Procfile (for AWS ECS or similar)
web: cd frontend && npm start
api: cd backend && uvicorn main:app --host 0.0.0.0 --port 8000
```

**Target domain:** `entitylinker.expertintheloop.io` (or similar subdomain)

**Environment variables for production:**
- `NEXTAUTH_URL=https://entitylinker.expertintheloop.io`
- `BIOMAPPER_API_KEY` - stored in backend only, never exposed to frontend

---

## TypeScript Interfaces (For Replit Agent)

```typescript
// Request to FastAPI backend (NOT directly to BioMapper2)
interface BatchMapRequest {
  names: string[];
  config: {
    annotationMode: 'missing' | 'all' | 'none';
    hints?: Record<string, Record<string, string | string[]>>;  // name -> {vocab: id(s)}
  };
}

// Internal: FastAPI calls BioMapper2 with this structure
interface BioMapperRequest {
  name: string;
  entity_type: 'biolink:SmallMolecule';
  annotation_mode: 'missing' | 'all' | 'none';
  identifiers?: Record<string, string | string[]>;  // Can be single string or array
}

// Response from BioMapper2 API
interface MapEntityResponse {
  query_name: string;
  resolved: boolean;
  primary_curie: string | null;
  chosen_kg_id: string | null;
  confidence_score: number | null;
  identifiers: Record<string, string[]>;
  error: string | null;
}

// Processed result with derived fields
interface MappingResult {
  rowIndex: number;           // Original row in uploaded file
  originalName: string;       // Raw input name
  resolvedName: string | null;
  resolved: boolean;
  primaryCurie: string | null;
  confidenceScore: number | null;
  confidenceTier: 'high' | 'medium' | 'low' | 'unknown';
  needsReview: boolean;
  identifiers: {
    hmdb: string[];
    chebi: string[];
    pubchem: string[];
    refmet: string[];
    lipidmaps: string[];
    kegg: string[];
    umls: string[];
    mesh: string[];
    unii: string[];
    chembl: string[];
  };
}

// Summary statistics
interface MappingSummary {
  totalRows: number;
  uniqueNames: number;
  resolved: number;
  resolutionRate: number;
  highQualityCount: number;
  highQualityRate: number;
  confidenceTierDistribution: {
    high: number;
    medium: number;
    low: number;
    unknown: number;
  };
  vocabularyCoverage: Record<string, number>;
  needsReviewCount: number;
}

// Job state for multi-step workflow
interface MappingJob {
  id: string;
  status: 'uploading' | 'configuring' | 'processing' | 'complete' | 'error';
  progress: {
    current: number;
    total: number;
  };
  config: {
    nameColumn: string;
    hintColumn: string | null;
    targetOntologies: string[];
    annotationMode: 'missing' | 'all' | 'none';
    minConfidenceTier: 'high' | 'medium' | 'low' | 'unknown';
  };
  summary: MappingSummary | null;
  results: MappingResult[];
  createdAt: Date;
}
```

---

## Google OAuth Configuration

**Access control:** `phenomehealth.org` domain + individual email whitelist

```javascript
// frontend/app/api/auth/[...nextauth]/route.ts
import NextAuth from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';

// Domain + individual email whitelist
const ALLOWED_DOMAIN = 'phenomehealth.org';
const ALLOWED_EMAILS = [
  // Add individual Gmail addresses here for non-org users
  // 'user@gmail.com',
];

export const authOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      authorization: {
        params: {
          // Hint Google login UI to show org accounts first (UX improvement)
          hd: ALLOWED_DOMAIN,
        },
      },
    }),
  ],
  callbacks: {
    async signIn({ user }) {
      const email = user.email || '';
      const domain = email.split('@')[1];

      // Allow if domain matches OR email is in whitelist
      if (domain === ALLOWED_DOMAIN) return true;
      if (ALLOWED_EMAILS.includes(email)) return true;

      // Reject with clear error
      return '/auth/error?error=AccessDenied';
    },
  },
  pages: {
    error: '/auth/error',
  },
};

const handler = NextAuth(authOptions);
export { handler as GET, handler as POST };
```

**Environment variables:**
- `GOOGLE_CLIENT_ID` - from Google Cloud Console
- `GOOGLE_CLIENT_SECRET` - from Google Cloud Console
- `NEXTAUTH_SECRET` - random string for session encryption
- `NEXTAUTH_URL` - production URL: `https://entitylinker.expertintheloop.io`

**Note:** The `hd` parameter only hints the Google UI; the `signIn` callback enforces security.

---

## Error Handling Patterns

### API Errors

| Error Type | HTTP Code | Cause | User Message | Action |
|------------|-----------|-------|--------------|--------|
| **Auth Failure** | 401/403 | Invalid or missing BIOMAPPER_API_KEY | "API configuration error. Contact administrator." | **NOT retryable** - surface immediately |
| **Timeout** | - | API takes >30s | "Request timed out. This compound may be too complex." | Retry up to 3x |
| **Network Error** | - | API unreachable | "BioMapper service is temporarily unavailable." | Retry with exponential backoff |
| **Rate Limited** | 429 | Too many concurrent | "Processing paused - reducing request rate." | Auto-reduce concurrency, retry |
| **Server Error** | 500+ | BioMapper internal error | "Temporary server error. Retrying..." | Retry with backoff |
| **Invalid Response** | 200 | Malformed JSON | "Unexpected response for [name]. Skipping." | Log and continue |
| **Empty Result** | 200 | No matches found | N/A (normal case) | Mark as unresolved |

**Critical:** Auth failures (401/403) should immediately stop the job and surface a clear error. Do NOT retry - it indicates a configuration problem with `BIOMAPPER_API_KEY`.

### Backend Error Handling (FastAPI)

```python
# backend/services/mapper.py
import httpx
from typing import AsyncIterator

class MappingError(Exception):
    def __init__(self, name: str, error_type: str, message: str, retryable: bool):
        self.name = name
        self.error_type = error_type
        self.message = message
        self.retryable = retryable

class MapperService:
    async def map_entity_with_retry(
        self,
        name: str,
        config: dict,
        max_retries: int = 3
    ) -> dict:
        last_error = None

        for attempt in range(max_retries):
            try:
                result = await self.client.map_entity(
                    name=name,
                    entity_type="biolink:SmallMolecule",
                    annotation_mode=config.get("annotation_mode", "missing"),
                    identifiers=config.get("hints", {}).get(name, {})
                )
                return self._process_result(name, result)

            except httpx.HTTPStatusError as e:
                if e.response.status_code in (401, 403):
                    # Auth failure - NOT retryable, stop immediately
                    raise MappingError(
                        name=name,
                        error_type="auth_failure",
                        message="Invalid BIOMAPPER_API_KEY. Check backend configuration.",
                        retryable=False
                    )
                elif e.response.status_code == 429:
                    # Rate limited - retryable with backoff
                    last_error = MappingError(name, "rate_limit", "Rate limited", True)
                elif e.response.status_code >= 500:
                    # Server error - retryable
                    last_error = MappingError(name, "server_error", str(e), True)
                else:
                    last_error = MappingError(name, "http_error", str(e), False)

            except httpx.TimeoutException:
                last_error = MappingError(name, "timeout", "Request timed out", True)

            except httpx.RequestError as e:
                last_error = MappingError(name, "network", str(e), True)

            if last_error and not last_error.retryable:
                break

            # Exponential backoff
            await asyncio.sleep(2 ** attempt)

        # Return error result
        return {
            "name": name,
            "resolved": False,
            "error": last_error.message if last_error else "Unknown error",
            "error_type": last_error.error_type if last_error else "unknown"
        }
```

### Frontend SSE Consumer

```typescript
// frontend/lib/useMapProgress.ts
export function useMapProgress(jobId: string | null) {
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId) return;

    const eventSource = new EventSource(`/api/backend/map/stream/${jobId}`);

    eventSource.addEventListener('progress', (e) => {
      setProgress(JSON.parse(e.data));
    });

    eventSource.addEventListener('error', (e) => {
      // Check if it's an auth failure from backend
      const data = JSON.parse((e as MessageEvent).data || '{}');
      if (data.error_type === 'auth_failure') {
        setError('API configuration error. Contact administrator.');
        eventSource.close();
      }
    });

    eventSource.onerror = () => {
      setError('Connection lost. Refresh to retry.');
      eventSource.close();
    };

    return () => eventSource.close();
  }, [jobId]);

  return { progress, error };
}
```

---

## Sample Test Data

### Metabolon Dataset (Real-World Vendor Data)

```csv
feature_id,original_name,match_level,hmdb_hint
method_1_29905,"1,3-Diphenylguanidine_CE45",MS2,
method_1_17931,"4,6-DIOXOHEPTANOIC ACID",MS2,HMDB03349
method_1_42235,"(2S,3S)-6'-methyl-3-phenylspiro[oxirane-2,7'-quinazolino[3,2-a][1,4]benzodiazepine]-5',13'-dione",MS2,
method_1_1434,"3-Amino-1,2,4-triazol",MS2,
method_2_12345,Glucose,CURATION,HMDB0000122
method_2_67890,Cholesterol,MS1,HMDB0000067
method_3_11111,ZINC000012345,MS2,
```

**Expected Results:**
- Row 1: High confidence (score ~2.47), RefMet + ChEBI IDs
- Row 2: Unknown confidence (HMDB hint pass-through), HMDB ID only
- Row 3: High confidence (score ~4.82), ChEBI ID
- Row 4: High confidence, MESH ID
- Row 7: Unresolved (vendor code format)

### Ground Truth Dataset (Evaluation Benchmark)

```csv
query,expected_hmdb,expected_pubchem,expected_chebi,category,difficulty
Indalpine,HMDB0253446,44668,CHEBI:134939,exact_match,easy
PG(16:1(9Z)/20:3(8Z,11Z,14Z)),HMDB0010594,52926484,CHEBI:89073,exact_match,easy
"PC(20:3(6,8,11-OH(5o/Die(13,5))",HMDB0289212,156996184,,fuzzy_match,hard
"Glucose-6-phoshafe lactate",HMDB0252789,,,fuzzy_match,hard
1-methylhistidine,HMDB0000001,"92105,7020397","CHEBI:50599,CHEBI:192560",arivale,medium
alpha-ketobutyrate,HMDB0000005,,,arivale,medium
pyridoxate,HMDB0000017,6723,CHEBI:17405,arivale,medium
```

**Categories:**
- `exact_match` - Canonical HMDB names, should resolve with high confidence
- `fuzzy_match` - Synthetic typos, tests error tolerance
- `arivale` - Real-world names from Arivale metabolomics study
- `synonym_match` - Alternative names that map to same compound
- `greek_letter` - Names with α/β/γ prefixes
- `numeric_prefix` - Names starting with numbers (1-methyl, 2-amino, etc.)
- `special_prefix` - Names with special characters

### Minimal Test Cases

**Success case:**
```json
{
  "name": "L-Alanine",
  "expected_resolved": true,
  "expected_tier": "high",
  "expected_vocabs": ["HMDB", "CHEBI", "PUBCHEM.COMPOUND", "refmet_id"]
}
```

**Hint case:**
```json
{
  "name": "4,6-DIOXOHEPTANOIC ACID",
  "identifiers": { "HMDB": "HMDB0003349" },
  "expected_resolved": true,
  "expected_tier": "unknown",
  "expected_hmdb": ["HMDB0003349"]
}
```

**Unresolved case:**
```json
{
  "name": "ZINC000012345",
  "expected_resolved": false,
  "expected_tier": "unknown"
}
```

**Fuzzy match case:**
```json
{
  "name": "Glucose-6-phoshafe lactate",
  "expected_resolved": true,
  "expected_tier": "low",
  "notes": "Typo should still resolve via fuzzy matching"
}
```

---

## Verification

1. Upload test file (Metabolon XLSX or sample CSV)
2. Select compound name column
3. Run mapping → verify progress indicator works
4. Check summary cards match notebook results
5. Verify charts render correctly
6. Download TSV → verify columns match selection
7. Download JSON → verify structure matches notebook output
8. Test edge cases: empty file, no matches, all high-confidence
9. **Verify SSE streaming works end-to-end:** Start a mapping job with 20+ names, confirm the progress bar increments in real-time rather than jumping from 0% to 100% after completion. This catches buffering issues in the proxy.
