---
title: "feat: Add Dev UI Deployment Alongside Production"
type: feat
status: active
date: 2026-05-01
origin: docs/brainstorms/dev-ui-deployment-requirements.md
---

# feat: Add Dev UI Deployment Alongside Production

## Overview

Add a second biomapper-ui instance at `dev-link.expertintheloop.io` deployed from a persistent `dev` branch, with manual dispatch for arbitrary branches. Production at `link.expertintheloop.io` remains unchanged. Both instances share the same Lightsail server with separate ports, directories, systemd services, and nginx configs.

## Problem Frame

biomapper-ui has a single deployment that auto-deploys from `main`. The recent 5-iteration deploy debugging cycle demonstrates the need for a safe environment to validate deployment and UI changes before they hit production. (see origin: `docs/brainstorms/dev-ui-deployment-requirements.md`)

## Requirements Trace

**Infrastructure**
- R1. Second full biomapper-ui instance at `dev-link.expertintheloop.io`
- R2. Dedicated ports: Express :8004, Python :8005
- R3. Code at `/home/ubuntu/biomapper-ui-dev/` with own `.env` and `.venv/`
- R4. Own systemd services: `biomapper-ui-dev-express.service`, `biomapper-ui-dev-python.service`
- R5. nginx site config with certbot SSL

**Automation & Workflow**
- R6. Auto-deploy from persistent `dev` branch
- R7. Manual `workflow_dispatch` with branch name input
- R8. Apply all production deploy lessons

**Branching & Routing**
- R9. Persistent `dev` branch
- R10. `dev` -> dev instance, `main` -> production (unchanged)

## Scope Boundaries

- Minimal change to `.github/workflows/deploy.yml`: only the concurrency group name changes from `deploy-production` to `lightsail-deploy` (shared with dev) to prevent concurrent deploys on the same server. No other modifications to the production workflow. (see Unit 4)
- The existing `dev-biomapper.expertintheloop.io` (:8003) is untouched
- No separate database needed — biomapper-ui is stateless
- First-time server setup (clone, nginx, certbot) is manual; only subsequent deploys are automated

### Deferred to Separate Tasks

- `.env` sync validation between prod and dev (a deploy-time warning script)
- Cross-instance health monitoring (dev deploy verifying prod is still healthy)

## Context & Research

### Relevant Code and Patterns

- `deploy/` — service file templates using `$DEPLOY_DIR` placeholder substituted by `sed` at deploy time
- `.github/workflows/deploy.yml` — production SSH deploy via `appleboy/ssh-action`, reference for forking
- `deploy/.env.example` — canonical env var list (note: `PYTHON_API_PORT=8000` in example but production uses `8002`)
- `deploy/nginx-link.conf` — nginx template with SPA fallback and Express proxy
- `deploy/README.md` — step-by-step manual setup guide
- `artifacts/api-server/src/app.ts:10` — Express reads `PYTHON_API_PORT` env var (defaults to `8000`)
- `artifacts/frontend/vite.config.ts` — requires `PORT` and `BASE_PATH` env vars at build time

### Institutional Learnings

- `docs/solutions/runtime-errors/systemd-protecthome-breaks-sibling-service-cache-2026-04-23.md` — `ProtectHome=read-only` breaks `~/.cache/uv/` for all services under the same user. Current service files already removed this directive. Dev service files must not reintroduce it.
- `docs/solutions/workflow-issues/github-actions-lightsail-ssh-deploy-monorepo-pitfalls-2026-04-29.md` — 8 lessons from the production deploy cycle. All apply to the dev workflow: no corepack enable, filtered workspace builds, no venv recreation, no script_stop with retry loops, VITE_* only exports, no nginx overwrite, cancel-in-progress: false, pin actions by SHA.
- `docs/solutions/developer-experience/biomapper-ui-deploy-cycle-2026-04-23.md` — port inventory and EnvironmentFile precedence. Port 8003 is already taken by dev-biomapper.

## Key Technical Decisions

- **Shared concurrency group `lightsail-deploy`**: Both prod and dev workflows use the same concurrency group to serialize all deploys to this server. Prevents concurrent `pnpm install` / `uv pip install` from corrupting the shared pnpm store (`~/.local/share/pnpm/store/`) or uv cache (`~/.cache/uv/`). Deploys are infrequent enough that queuing is acceptable.
- **Separate `deploy/dev/` directory for dev config files**: Keeps dev service files, nginx config, and `.env.example` cleanly separated from production templates. Avoids filename collision and makes it clear which files belong to which environment.
- **workflow_dispatch branch input defaults to `dev`**: Prevents blank-input failures. The script validates the input before attempting git operations.
- **nginx config created manually, never touched by CI**: Same pattern as production — certbot modifies the live config for SSL, so CI must never overwrite it.
- **Dev .env provisioned manually**: Same pattern as production. A `deploy/dev/.env.example` documents which values differ.

## Open Questions

### Resolved During Planning

- **DNS for dev-link.expertintheloop.io**: User confirmed DNS is ready.
- **Concurrent deploy safety**: Shared concurrency group `lightsail-deploy` serializes all deploys. No flock needed.
- **uv cache isolation**: Not needed if deploys are serialized via concurrency group. If concurrent deploys are ever needed, set `UV_CACHE_DIR` per deploy invocation.
- **Dev .env API keys**: Dev `.env` should point `BIOMAPPER_BASE_URL` at dev-biomapper.expertintheloop.io (:8003) by default. `BIOMAPPER_API_KEY` is shared (same key works for both).
- **Concurrency group strategy**: The brainstorm proposed separate groups (`deploy-dev` / `deploy-production`), but planning discovered that the shared pnpm store and uv cache create corruption risk under concurrent installs. A single shared group (`lightsail-deploy`) is safer and simpler; the cost is occasional queuing between prod and dev deploys.

### Deferred to Implementation

- **Clerk configuration for dev domain**: If Clerk auth is active, the Clerk dashboard needs redirect URLs for `dev-link.expertintheloop.io`. Currently Clerk is optional — verify whether it's enabled in production.
- **VITE_CLERK_PROXY_URL**: Must be `https://dev-link.expertintheloop.io/api/__clerk` in dev `.env` if Clerk is active. If Clerk is disabled, this can be empty.

## Output Structure

```
deploy/dev/
  biomapper-ui-dev-express.service
  biomapper-ui-dev-python.service
  nginx-dev-link.conf
  .env.example
  README.md
.github/workflows/
  deploy-dev.yml
```

## Implementation Units

- [x] **Unit 1: Create dev service files and env template**

  **Goal:** Add systemd service templates and env example for the dev instance.

  **Requirements:** R2, R3, R4

  **Dependencies:** None

  **Files:**
  - Create: `deploy/dev/biomapper-ui-dev-express.service`
  - Create: `deploy/dev/biomapper-ui-dev-python.service`
  - Create: `deploy/dev/.env.example`
  - Create: `deploy/dev/README.md`

  **Approach:**
  - Copy production service files as starting point, then modify:
    - `SyslogIdentifier` → `biomapper-ui-dev-express` / `biomapper-ui-dev-python`
    - Express: `Environment=PORT=8004`
    - Python: `ExecStart` hardcodes `--port 8005` (uvicorn reads port from CLI arg, not env var — must be changed in ExecStart line, not via Environment directive)
    - `EnvironmentFile=$DEPLOY_DIR/.env` (where `$DEPLOY_DIR` = `/home/ubuntu/biomapper-ui-dev`)
  - Do NOT add `ProtectHome=read-only` — this is the documented pitfall
  - Port assignment: Express port is set both in the service file (`Environment=PORT=8004`) and in `.env` (`PORT=8004`), matching production's pattern where both are set to the same value. systemd's `EnvironmentFile` overrides inline `Environment` for the same key, so the `.env` value is authoritative at runtime. The Python service does NOT use a PORT environment variable — its port is hardcoded in `ExecStart` (`--port 8005`).
  - `.env.example` based on production `deploy/.env.example` with dev-specific values:
    - `PORT=8004` (Express runtime port — NOT used by Vite build; the build command passes `PORT=5173` as a Vite dev-server placeholder that does not affect the static output)
    - `PYTHON_API_PORT=8005`
    - `BIOMAPPER_BASE_URL=http://localhost:8003/api/v1` (points to dev biomapper2)
    - `BIOMAPPER_DEV_BASE_URL=http://localhost:8003/api/v1` (same as BIOMAPPER_BASE_URL — both point to dev biomapper2 on this instance, so the env-toggle feature works but both environments resolve to the dev backend)
    - `VITE_CLERK_PROXY_URL=https://dev-link.expertintheloop.io/api/__clerk`
  - `README.md` documents first-time server setup steps for the dev instance. Note that `corepack enable` is NOT required (pnpm is already available from initial server setup). Also note that `main.py`'s `load_dotenv()` resolves `.env` via three parent levels from `artifacts/python-api/`, which maps to `$DEPLOY_DIR/.env` — same as the systemd `EnvironmentFile` path.

  **Patterns to follow:**
  - `deploy/biomapper-ui-express.service` — production template
  - `deploy/biomapper-ui-python.service` — production template
  - `deploy/.env.example` — production env template
  - `deploy/README.md` — production setup guide

  **Test expectation:** none — config files, no behavioral change

  **Verification:**
  - Service files use `$DEPLOY_DIR` placeholder consistently
  - Ports are 8004/8005, not 8080/8002
  - `SyslogIdentifier` values are unique (not colliding with production)
  - No `ProtectHome=read-only` directive present
  - `ProtectSystem=strict` is preserved with `ReadWritePaths=$DEPLOY_DIR` pointing to the dev directory

- [x] **Unit 2: Create dev nginx config**

  **Goal:** Add nginx site config template for `dev-link.expertintheloop.io`.

  **Requirements:** R1, R5

  **Dependencies:** Unit 1 (port numbers must match)

  **Files:**
  - Create: `deploy/dev/nginx-dev-link.conf`

  **Approach:**
  - Copy `deploy/nginx-link.conf` and modify:
    - `server_name dev-link.expertintheloop.io`
    - `root $DEPLOY_DIR/artifacts/frontend/dist/public` (dev DEPLOY_DIR)
    - `proxy_pass http://127.0.0.1:8004` (dev Express port)
  - Keep `proxy_buffering off` and `proxy_read_timeout 300s` — required for SSE
  - This config is applied manually once during first-time setup: copy, run `sed` to substitute `$DEPLOY_DIR` (nginx does not expand shell variables), symlink to sites-enabled, then certbot adds SSL. CI never overwrites it.

  **Patterns to follow:**
  - `deploy/nginx-link.conf` — production nginx template

  **Test expectation:** none — config template

  **Verification:**
  - `server_name` is `dev-link.expertintheloop.io`
  - `proxy_pass` points to port 8004
  - All proxy headers and SSE directives match production config
  - No literal `$DEPLOY_DIR` remains in the file after sed substitution

- [x] **Unit 3: Create dev deploy workflow**

  **Goal:** GitHub Actions workflow for deploying to the dev instance.

  **Requirements:** R6, R7, R8, R10

  **Dependencies:** Unit 1 (service file names must match)

  **Files:**
  - Create: `.github/workflows/deploy-dev.yml`

  **Approach:**
  - Fork from `.github/workflows/deploy.yml` with these changes:
    - **Triggers**: `push` on `dev` branch (same path filters) + `workflow_dispatch` with `branch` input (default: `dev`)
    - **Concurrency**: `group: lightsail-deploy` (shared with prod), `cancel-in-progress: false`
    - **Environment**: `development` (create in GitHub settings, same secrets)
    - **DEPLOY_DIR**: `/home/ubuntu/biomapper-ui-dev`
    - **Git fetch**: `git fetch origin $BRANCH && git reset --hard origin/$BRANCH` where `$BRANCH` comes from dispatch input or defaults to `dev`
    - **Service files**: copy `deploy/dev/biomapper-ui-dev-express.service` and `deploy/dev/biomapper-ui-dev-python.service`
    - **sed substitution**: target `/etc/systemd/system/biomapper-ui-dev-*.service`
    - **Service restart**: `biomapper-ui-dev-python biomapper-ui-dev-express`
    - **Health checks**: `127.0.0.1:8005/health` (Python) and `127.0.0.1:8004/api/healthz` (Express)
  - Apply all 8 documented deploy lessons (R8):
    - No `corepack enable`
    - Filtered workspace builds (`--filter @workspace/frontend`, `--filter @workspace/api-server`)
    - No venv recreation (`uv pip install --python .venv/bin/python`)
    - No `script_stop` — manage `set -e` / `set +e` manually
    - Only export `VITE_*` vars for build
    - Never copy nginx config
    - `cancel-in-progress: false`
    - Pin `appleboy/ssh-action` to SHA `029f5b4aeeeb58fdfe1410a5d17f967dacf36262` (v1.0.3, same as production)
  - Run `pnpm run typecheck` before builds (same as production)
  - Branch input handling (two distinct cases):
    - **Empty/blank input**: GitHub Actions `default: 'dev'` on the input field handles the UI case. For API-triggered dispatches that may pass an empty string, add `BRANCH=${BRANCH:-dev}` as the first line of the shell script.
    - **Nonexistent branch**: After resolving the branch name, validate with `git ls-remote --exit-code origin "refs/heads/$BRANCH"` and fail with a clear error message if the branch doesn't exist on the remote.
  - Path filters must include `deploy/dev/**` and self-reference `.github/workflows/deploy-dev.yml`
  - **Prerequisite**: Create `development` environment in GitHub repository settings with `LIGHTSAIL_HOST` and `LIGHTSAIL_SSH_KEY` secrets before first workflow run

  **Patterns to follow:**
  - `.github/workflows/deploy.yml` — production workflow (the reference implementation)

  **Test scenarios:**
  - Happy path: push to `dev` triggers deploy, workflow completes with healthy services on ports 8004/8005
  - Happy path: workflow_dispatch with branch `feat/test` deploys that branch to dev instance
  - Edge case: workflow_dispatch with blank branch input falls back to `dev` branch
  - Edge case: workflow_dispatch with nonexistent branch fails gracefully with clear error
  - Edge case: simultaneous push to `main` and `dev` — second deploy queues behind first (shared concurrency group)
  - Error path: health check fails — workflow reports failure with rollback info (previous SHA + branch)

  **Verification:**
  - Workflow triggers on `dev` branch push and `workflow_dispatch`
  - Concurrency group is `lightsail-deploy` (matches production workflow)
  - All port references are 8004/8005, not 8080/8002
  - Service file names reference `dev` variants
  - `DEPLOY_DIR` is `/home/ubuntu/biomapper-ui-dev`
  - The `dev` branch (Unit 5) must exist on origin before the first workflow run. A `workflow_dispatch` targeting `dev` before Unit 5 completes will fail at the git fetch step.

- [x] **Unit 4: Update production workflow concurrency group**

  **Goal:** Change production workflow concurrency group to match the shared group name.

  **Requirements:** R8 (shared concurrency group is a deploy lesson for multi-instance safety)

  **Dependencies:** None (can be done in parallel with other units)

  **Files:**
  - Modify: `.github/workflows/deploy.yml`

  **Approach:**
  - Change `group: deploy-production` to `group: lightsail-deploy`
  - This is the only change to the production workflow
  - The shared group ensures prod and dev deploys never run concurrently on the same server

  **Patterns to follow:**
  - Existing concurrency block in `deploy.yml`

  **Test scenarios:**
  - Happy path: production deploy still triggers on `main` push and completes successfully
  - Integration: if a dev deploy is running, production deploy queues (does not cancel)

  **Verification:**
  - Only the concurrency group name changed; no other modifications
  - `cancel-in-progress: false` is preserved

- [ ] **Unit 5: Create persistent `dev` branch**

  **Goal:** Create the `dev` branch and push it to origin.

  **Requirements:** R9

  **Dependencies:** Units 1-4 merged to `main` first

  **Files:** None (git branch operation)

  **Approach:**
  - Create `dev` branch from `main` after all deploy config is merged
  - Push to origin: `git push -u origin dev`
  - **Note**: This push triggers the auto-deploy workflow. If server setup (Unit 6) is not yet complete, the deploy will fail at `cd $DEPLOY_DIR` (directory doesn't exist yet) and fire a failure notification — this is expected and not actionable until Unit 6 completes. The first successful auto-deploy happens after server setup is done and a subsequent push to `dev` occurs. **Recommended order**: Do server setup (Unit 6) first by cloning from `main`, then push the `dev` branch to get a clean first auto-deploy.

  **Test expectation:** none — branch creation

  **Verification:**
  - `dev` branch exists on origin
  - Branch contains all deploy config from Units 1-4

- [ ] **Unit 6: First-time server setup (manual)**

  **Goal:** Bootstrap the dev instance on Lightsail.

  **Requirements:** R1, R3, R5

  **Dependencies:** Units 1-4 merged to `main` (config files available), DNS ready (confirmed). Can be done before or after Unit 5 — clone `main` if `dev` branch doesn't exist yet, or clone and checkout `dev` if it does.

  **Files:** None (server-side operations, guided by `deploy/dev/README.md`)

  **Approach:**
  - SSH to Lightsail and follow `deploy/dev/README.md`:
    1. Clone repo to `/home/ubuntu/biomapper-ui-dev/`, checkout `dev` branch (or `main` if doing setup before Unit 5)
    2. `pnpm install`
    3. Create Python venv at repo root: `cd /home/ubuntu/biomapper-ui-dev && ~/.local/bin/uv venv .venv --python 3.11` (first-time only — subsequent deploys via CI must NOT recreate the venv, per R8 lesson)
    4. `~/.local/bin/uv pip install --python .venv/bin/python -r artifacts/python-api/requirements.txt`
    5. Copy `deploy/dev/.env.example` to `.env`, fill in actual values
    6. Build frontend: `PORT=5173 BASE_PATH="/" pnpm --filter @workspace/frontend run build`
    7. Build Express: `pnpm --filter @workspace/api-server run build`
    8. Install systemd services (copy + sed $DEPLOY_DIR + daemon-reload + enable + start)
    9. Install nginx config (copy + sed $DEPLOY_DIR + symlink + nginx -t + reload)
    10. Run certbot: `sudo certbot --nginx -d dev-link.expertintheloop.io`
    11. Verify: curl health endpoints on ports 8004 and 8005, curl `https://dev-link.expertintheloop.io/`

  **Test scenarios:**
  - Happy path: after setup, `https://dev-link.expertintheloop.io/` loads the frontend
  - Happy path: `curl http://127.0.0.1:8005/health` returns healthy
  - Happy path: `curl http://127.0.0.1:8004/api/healthz` returns healthy
  - Error path: production services remain healthy after dev instance startup (`systemctl status biomapper-ui-express biomapper-ui-python`)

  **Verification:**
  - Dev frontend loads at `https://dev-link.expertintheloop.io/`
  - Dev Express responds on port 8004
  - Dev Python responds on port 8005
  - Production services unaffected: `link.expertintheloop.io` still works
  - `journalctl -u biomapper-ui-dev-express` and `journalctl -u biomapper-ui-dev-python` show clean logs

## System-Wide Impact

- **Interaction graph**: The dev deploy workflow shares the `lightsail-deploy` concurrency group with production, meaning a queued dev deploy blocks a queued prod deploy and vice versa. This is intentional — it prevents resource contention.
- **Error propagation**: A failed dev deploy has no impact on production. The dev services have separate systemd units with `Restart=always`. A crash-looping dev service does not affect production.
- **State lifecycle risks**: If a `workflow_dispatch` deploys a feature branch, the dev instance code diverges from the `dev` branch. The next push to `dev` will overwrite the feature branch code via `git reset --hard origin/dev`. This is expected behavior.
- **Unchanged invariants**: Production deploy workflow (`.github/workflows/deploy.yml`) changes only the concurrency group name — triggers, build steps, service files, ports, and health checks are untouched. Production services, nginx config, and systemd units are not modified.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Dev deploy overwrites production service files | Separate service file names (`biomapper-ui-dev-*`) and separate `DEPLOY_DIR` |
| Shared pnpm/uv cache corruption from concurrent installs | Shared concurrency group serializes all deploys |
| Dev `ProtectHome` breaks sibling services | Service files explicitly do not include `ProtectHome=read-only` |
| certbot run on dev domain modifies prod nginx config | certbot adds a new server block for the new domain; does not modify existing blocks. Verify with `nginx -t` after certbot |
| Server resource contention (2 CPUs, 7.6GB RAM) | Both instances are lightweight (Node + Python); monitor memory usage after first deploy |
| workflow_dispatch with typo'd branch fails confusingly | Script validates branch exists on remote before `git reset --hard` |

## Documentation / Operational Notes

- `deploy/dev/README.md` serves as the runbook for first-time setup
- After first-time setup, subsequent deploys are fully automated via GitHub Actions
- To manually deploy to dev: trigger `deploy-dev.yml` via workflow_dispatch in GitHub
- To check dev instance health: `curl http://127.0.0.1:8005/health && curl http://127.0.0.1:8004/api/healthz`
- To view dev logs: `journalctl -u biomapper-ui-dev-express -f` or `journalctl -u biomapper-ui-dev-python -f`
- **Rollback**: To revert the dev instance after a failed deploy, use `workflow_dispatch` with a known-good branch or SHA. Alternatively, SSH in and run `cd /home/ubuntu/biomapper-ui-dev && git reset --hard <known-good-sha>`, rebuild, and restart services. The deploy workflow logs the previous SHA for reference.

## Sources & References

- **Origin document:** [docs/brainstorms/dev-ui-deployment-requirements.md](docs/brainstorms/dev-ui-deployment-requirements.md)
- Production deploy workflow: `.github/workflows/deploy.yml`
- Production service templates: `deploy/biomapper-ui-express.service`, `deploy/biomapper-ui-python.service`
- Production nginx template: `deploy/nginx-link.conf`
- Deploy pitfalls: `docs/solutions/workflow-issues/github-actions-lightsail-ssh-deploy-monorepo-pitfalls-2026-04-29.md`
- ProtectHome bug: `docs/solutions/runtime-errors/systemd-protecthome-breaks-sibling-service-cache-2026-04-23.md`
- Deploy cycle lessons: `docs/solutions/developer-experience/biomapper-ui-deploy-cycle-2026-04-23.md`
- Server reference: `/servers` command
