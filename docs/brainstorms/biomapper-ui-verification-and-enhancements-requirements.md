---
date: 2026-04-21
topic: biomapper-ui-verification-and-enhancements
---

# Biomapper UI: Verification, Tooltips, Benchmark Stub & Deployment

## Problem Frame

Biomapper-UI is a React + Express + FastAPI application for entity linking (mapping compound/entity names to standardized identifiers via the BioMapper2 API). The app runs on Replit but has several gaps:

1. **Uncertain API correctness** — Batch processing ran suspiciously fast during testing; it's unclear whether the API is returning real, accurate results or failing silently.
2. **Missing option documentation** — Users configuring mapping jobs don't have enough context about what each option does, what defaults mean, or what each annotator provides.
3. **No benchmarking capability** — There's no way to evaluate the mapper's accuracy against known-correct data. The UI needs a toggle for future benchmark mode, but full implementation is deferred.
4. **No production deployment** — The app is only on Replit; it needs to run on the existing AWS Lightsail instance alongside the BioMapper2 API.

## Requirements

**API Verification & Native Batching**

- R1. Create a standalone test script that calls the BioMapper2 API directly (bypassing the UI) with 3-5 known compounds (e.g., L-Histidine, Glucose, Acetyl-CoA) and prints full results — confirming real identifiers are returned with expected confidence tiers.
- R2. If R1 confirms the current per-entity approach works correctly, refactor the Python mapping service to use the biomapper SDK's native batch method for efficiency. If R1 reveals issues, fix those first. Preserve progress visibility to the frontend (the exact streaming granularity — per-entity vs per-chunk — is deferred to planning). Note: the current semaphore-based approach (10 concurrent individual calls) already works — this refactor is an efficiency improvement, not a correctness fix.
- R3. Run end-to-end test through the UI: upload a small test file, verify real results appear on the dashboard with actual identifiers and confidence scores.

**Option Documentation & Tooltips**

- R4. Add info-icon tooltips to every configuration field on the upload page: Name Column, Entity Type, Annotation Mode, Annotators, Provided ID Columns, Display Vocabularies, and Confidence Filter.
- R5. Show annotator descriptions alongside each annotator checkbox. Use descriptions from the discovery API if available; if the API doesn't return descriptions, hardcode short descriptions for the known annotators (acceptable since the annotator set changes infrequently).
- R6. Clearly explain default behavior: what happens when Annotators is left blank ("uses all available annotators"), what each Annotation Mode means in practice, and what the entity type presets control.

**Ground Truth Benchmarking — Stub Only**

- R7. Add a mode toggle at the top of the upload page, above the file drop zone (visible before uploading): "Entity Linking" (default) vs "Benchmark". Include a hover question-mark icon with a tooltip explaining the difference. The toggle is UI-only for now — selecting "Benchmark" shows a "Coming soon" message or disabled state. Full benchmark implementation (answer columns, metrics, comparison) will be designed in a separate brainstorm once entity linking is verified and deployed.

**AWS Lightsail Deployment**

- R8. Deploy biomapper-ui to the existing Lightsail instance (35.161.242.62) alongside the BioMapper2 API, with a systemd service, nginx reverse proxy, and HTTPS via Let's Encrypt.
- R9. The UI's Python FastAPI service should be configured to call the BioMapper2 API at localhost (on the same instance) rather than the public URL, for lower latency and no external network dependency. The BioMapper2 API still requires an API key on localhost.
- R10. Environment variables (Clerk keys, BIOMAPPER_API_KEY, ALLOWED_EMAIL_DOMAINS) must be configured on the server, not hardcoded.

## Success Criteria

- A test script confirms the BioMapper2 API returns real identifiers for known compounds
- The UI end-to-end produces correct mapping results with real identifiers
- Upload page has tooltips on all config fields with clear, helpful descriptions
- Benchmark toggle is visible and communicates "coming soon"
- The app is accessible via HTTPS on the Lightsail instance

## Scope Boundaries

- **Not in scope**: User management, role-based access (Clerk handles auth as-is)
- **Not in scope**: New annotators or changes to the BioMapper2 API itself
- **Not in scope**: Persistent job storage or database — current in-memory job store is fine
- **Not in scope**: CI/CD pipeline for biomapper-ui (manual deployment is acceptable for now)
- **Not in scope (this round)**: Full benchmark workflow implementation (answer column selection, metrics computation, comparison dashboard). Deferred to a separate brainstorm.

## Key Decisions

- **Mode toggle over separate page**: Benchmark mode lives on the same upload page as Entity Linking, toggled at the top. Stub only for now.
- **Same Lightsail instance**: Deploy alongside BioMapper2 rather than a separate server. Cheaper, simpler, and enables localhost API calls.
- **Native batching (conditional on R1)**: Switch to SDK batch method only if current per-entity approach is confirmed working first. The exact batch method (`map_entities()` vs `map_dataset_file_iter()`) and progress streaming approach are deferred to planning.
- **Benchmark deferred**: Full ground truth workflow needs its own brainstorm to resolve matching semantics, metric definitions, and data flow before implementation.

## Dependencies / Assumptions

- The BioMapper2 API at `biomapper.expertintheloop.io` (and on the Lightsail instance at localhost:8001) is operational and returning correct results. R1 will verify this.
- The `biomapper` SDK v1.0.1 is the correct client package. The Lightsail instance runs the server-side `biomapper2` package.
- SSH access to the Lightsail instance is available via `~/.ssh/lightsail-expert.pem`.
- Port 8000 (Python FastAPI) and port 8080 (Express) are available on the Lightsail instance and not used by other services.
- Clerk proxy URLs will need to be updated for the new domain/path — this is part of the deployment configuration.

## Outstanding Questions

### Deferred to Planning

- [Affects R2][Technical] When switching to batch SDK method, how should progress streaming work? Options: (a) chunk-level progress (progress bar jumps per batch chunk), (b) use `map_dataset_file_iter()` NDJSON streaming instead for per-entity progress, (c) hybrid approach. Requires inspecting the actual SDK method signatures.
- [Affects R8][Technical] What subdomain or path should the UI be served at? Options: `biomapper-ui.expertintheloop.io`, or a path like `biomapper.expertintheloop.io/ui/`. This affects nginx config, Clerk redirect URLs, and Vite BASE_URL.
- [Affects R5][Needs research] Does the BioMapper2 discovery API's `/annotators` endpoint return descriptions? If not, hardcode descriptions for known annotators.
- [Affects R2][Technical] The `JobStore._lock` is defined but unused in `add_result` and `to_dict`. Verify whether the single-writer pattern is safe, or add locking before switching to batch writes.

## Next Steps

-> `/ce:plan` for structured implementation planning (3 workstreams: verify + batch, tooltips, deploy; plus benchmark toggle stub)
