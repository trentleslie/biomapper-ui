---
title: "pnpm --frozen-lockfile fails after removing a dependency from package.json"
date: 2026-05-08
category: build-errors
module: frontend
problem_type: build_error
component: tooling
symptoms:
  - "ERR_PNPM_OUTDATED_LOCKFILE Cannot install with frozen-lockfile because pnpm-lock.yaml is not up to date"
  - "specifiers in the lockfile don't match specifiers in package.json"
  - "GitHub Actions deploy fails at pnpm install step"
root_cause: config_error
resolution_type: config_change
severity: medium
tags:
  - pnpm
  - lockfile
  - ci-cd
  - github-actions
  - frozen-lockfile
  - dependency-removal
---

# pnpm --frozen-lockfile fails after removing a dependency from package.json

## Problem

After removing `next-themes` from `artifacts/frontend/package.json` (as part of removing dark mode support), the GitHub Actions dev deploy failed at `pnpm install --frozen-lockfile` because the lockfile still referenced the removed package.

A secondary issue was also caught: the AppShell TopBar referenced a nonexistent `/assets/favicon.png`, and the browser tab title used incorrect casing ("Biomapper" instead of "BioMapper").

## Symptoms

- GitHub Actions deploy job fails with exit code 1
- Error: `ERR_PNPM_OUTDATED_LOCKFILE Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with <ROOT>/artifacts/frontend/package.json`
- Failure reason: `1 dependencies were removed: next-themes@^0.4.6`
- Broken image icon in TopBar where the Phenome logo should appear

## What Didn't Work

- Could not run `pnpm install` locally to regenerate the lockfile — pnpm was not installed on the dev machine, and the latest pnpm via npx required Node.js features (`node:sqlite`) not available in the local Node v20
- `corepack enable && corepack prepare pnpm@latest` failed with `EACCES` permission error on symlink creation

## Solution

**Lockfile fix:** Ran `pnpm install --no-frozen-lockfile` on the Lightsail server (which already had pnpm 10.33.2 installed), then copied the updated lockfile back to the local repo:

```bash
# On Lightsail (where pnpm is installed)
ssh lightsail "cd /home/ubuntu/biomapper-ui-dev && pnpm install --no-frozen-lockfile"

# Copy updated lockfile back
scp lightsail:/home/ubuntu/biomapper-ui-dev/pnpm-lock.yaml ./pnpm-lock.yaml

# Commit and push
git add pnpm-lock.yaml
git commit -m "chore: update pnpm-lock.yaml after next-themes removal"
git push origin dev
```

**Favicon fix:** Replaced the Replit orange square favicon SVG with a Phenome-branded navy "P", updated the AppShell to reference `/favicon.svg` (which exists in `public/`) instead of `/assets/favicon.png` (which never existed), and corrected the browser tab title to "BioMapper | Phenome Health".

## Why This Works

`pnpm install --frozen-lockfile` (the default in CI) requires exact agreement between `package.json` specifiers and `pnpm-lock.yaml` entries. When a dependency is removed from `package.json` but the lockfile still lists it, the specifiers diverge and the install fails. Running `pnpm install` without `--frozen-lockfile` regenerates the lockfile to match the current `package.json`.

The favicon referenced a path (`/assets/favicon.png`) that was never created — the `public/` directory only contained `favicon.svg`. Vite serves files from `public/` at the root path, so `/favicon.svg` is the correct reference.

## Prevention

- **Always regenerate the lockfile when changing dependencies.** After adding or removing packages in `package.json`, run `pnpm install` to update `pnpm-lock.yaml` before committing. If pnpm isn't available locally, use the deploy server or a CI step.
- **Verify asset paths exist before referencing them.** Check `ls public/` or `ls public/assets/` before using paths like `/assets/favicon.png` in components.
- **Use the canonical product name casing.** BioMapper (camelCase B+M), not Biomapper or biomapper, in user-facing strings.

## Related Issues

- PR trentleslie/biomapper-ui#11 — the Phenome UI overhaul that introduced the dependency removal
- `docs/solutions/workflow-issues/tailwind-v4-phenome-design-system-migration-2026-05-08.md` — the parent workflow documentation for the design system migration
