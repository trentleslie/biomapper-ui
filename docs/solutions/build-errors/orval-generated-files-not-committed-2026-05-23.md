---
title: "Orval-generated type files not committed after OpenAPI spec changes"
date: 2026-05-23
last_updated: 2026-07-11
category: build-errors
module: api-codegen
problem_type: build_error
component: tooling
symptoms:
  - "TypeScript compilation fails with module not found errors in api-zod package"
  - "index.ts re-exports from files that don't exist in the repo"
  - "Build works locally but fails on fresh clone or CI"
  - "Frontend tsc reports 'Property X does not exist' despite regenerated source (composite libs not rebuilt)"
root_cause: missing_workflow_step
resolution_type: workflow_improvement
severity: high
tags:
  - orval
  - codegen
  - openapi
  - zod
  - typescript
  - git
  - composite-project
  - tsc-build
---

# Orval-generated type files not committed after OpenAPI spec changes

## Problem

After adding new API endpoints to the OpenAPI spec and running orval codegen, some generated type files were created on disk but never committed to git. The `index.ts` barrel file re-exported these missing files, causing TypeScript compilation to fail for any consumer of the package — including fresh clones and CI.

> **Recurred 2026-07-11 (PR #26).** Adding one enum field (`chosenKgIdReview`) to `MappingResultItem` created a new file `lib/api-zod/src/generated/types/mappingResultItemChosenKgIdReview.ts` that was left unstaged by a `git add <modified files>` — Greptile's build-from-committed-state flagged it as a **P1 "Missing generated type."** The "run `git status` after codegen" advice below did not prevent it, which is why the Prevention section now leans on an automated codegen-drift guard rather than human vigilance. The same PR also surfaced a distinct, related trap — see "Composite libraries serve stale declarations."

## Symptoms

- `tsc -b` fails with "Cannot find module './createFlagParams'" or similar
- `lib/api-zod/src/generated/types/index.ts` references files that don't exist in git
- Local builds work because the files exist on disk from a previous codegen run
- CI or fresh clones fail because the files were never committed

## What Didn't Work

- Running `tsc -b` locally to verify — it passed because the files existed on disk, masking the missing-commit issue

## Solution

After running orval codegen, check `git status` for any untracked files in the generated directories and stage them:

```bash
# After running orval codegen
cd lib/api-spec && npx orval

# Check for new generated files
git status lib/api-client-react/src/generated/ lib/api-zod/src/generated/

# Stage any untracked generated files
git add lib/api-client-react/src/generated/ lib/api-zod/src/generated/
```

In this case, `createFlagParams.ts` and `deleteFlagParams.ts` in `lib/api-zod/src/generated/types/` were the missing files.

## Why This Works

Orval's `clean: true` setting wipes and regenerates the entire output directory on each run. When new API operations are added, orval creates new type files (one per schema). The `index.ts` barrel is regenerated to re-export all types including the new ones. If the new type files aren't committed, the barrel's imports break.

The issue is that `git add` on modified files doesn't catch new untracked files. You need to explicitly check for and stage them.

## Composite libraries serve stale declarations (a second, related trap)

Same PR (2026-07-11), different failure: after regen, `tsc --noEmit -p artifacts/frontend/tsconfig.json` failed with `error TS2339: Property 'chosenKgIdReview' does not exist on type 'MappingResultItem'` — even though the field *was* present in the regenerated `lib/api-client-react/src/generated`. Deleting `*.tsbuildinfo` did not help.

**Cause:** the frontend references `@workspace/api-client-react` / `@workspace/api-zod` as `composite: true` TypeScript projects (via `references` in the frontend tsconfig). tsc resolves `MappingResultItem` from the lib's **emitted `dist/*.d.ts`**, not its source — and those declarations only refresh when the lib is *rebuilt*. Regenerating the lib source is invisible to the leaf typecheck until `tsc --build` re-emits the declarations. `.tsbuildinfo` is only the incremental cache, so deleting it changes nothing.

**Fix — rebuild composite libs before typechecking the leaf:**

```bash
# Wrong order — reads stale dist/*.d.ts → TS2339
node_modules/.bin/tsc --noEmit -p artifacts/frontend/tsconfig.json

# Right order (what CI's `pnpm run typecheck` does):
node_modules/.bin/tsc --build          # typecheck:libs — re-emits composite libs' .d.ts
node_modules/.bin/tsc --noEmit -p artifacts/frontend/tsconfig.json   # → 0 errors
```

Simplest: run the repo's full `pnpm run typecheck`, which already sequences `typecheck:libs` (`tsc --build`) before the per-package leaf typecheck. Never typecheck the frontend leaf in isolation after a codegen change.

## Prevention

The 2026-07-11 recurrence shows the manual "run `git status` after codegen" habit is not reliable on its own — prefer an automated guard:

- **Automated codegen-drift guard (strongest).** In CI and/or a pre-commit hook, regenerate and fail on any diff: `pnpm --filter api-spec run codegen && git diff --exit-code -- 'lib/**/src/generated'`. A non-empty diff means the committed generated code is out of sync with `openapi.yaml` — this catches both stale files AND unstaged new files without relying on anyone remembering.
- **Stage the whole generated tree**, not a hand-picked file list: `git add lib/**/src/generated` (or `git add -A` scoped to the codegen output), then confirm `git status --porcelain` shows no `??` under any `generated/` dir.
- **Validate the committed state, not local disk.** A green build on your working copy proves nothing — the new file exists locally and stale `dist` output lingers locally. Mirror CI/Greptile: a fresh checkout, or `node_modules/.bin/tsc --build --force`.
- **Always run the repo's full `pnpm run typecheck`** (which runs `tsc --build` for the composite libs before the leaf typecheck), never just `tsc --noEmit -p artifacts/frontend/tsconfig.json`.
- In code review, verify generated-file diffs include any new files mentioned in `index.ts` re-exports.

## Related Issues

- [PR #26](https://github.com/trentleslie/biomapper-ui/pull/26) — feat: surface resolver ChEBI-conflict review flag (2026-07-11 recurrence + the composite-library `tsc --build` trap)
- [PR #20](https://github.com/trentleslie/biomapper-ui/pull/20) — feat: consume dynamic vocabulary presets from entity types API (original occurrence)
- `lib/api-spec/orval.config.ts` — orval configuration with `clean: true`
