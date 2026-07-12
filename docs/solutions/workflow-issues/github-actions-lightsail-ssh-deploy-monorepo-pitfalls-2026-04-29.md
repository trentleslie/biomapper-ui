---
title: "GitHub Actions SSH deploy to Lightsail: monorepo pitfalls"
date: 2026-04-29
category: workflow-issues
module: biomapper-ui
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - "Setting up GitHub Actions auto-deploy via SSH to a persistent VM (Lightsail, EC2, droplet)"
  - "Deploying a pnpm/npm monorepo where some workspaces are dev-only or platform-specific"
  - "Deploying multi-service apps (frontend + backend + Python API) on a shared host"
  - "Using appleboy/ssh-action for SSH-based deployments"
tags: [github-actions, aws-lightsail, ssh-deploy, pnpm-monorepo, ci-cd, appleboy-ssh-action, systemd, multi-service]
---

# GitHub Actions SSH deploy to Lightsail: monorepo pitfalls

## Context

biomapper-ui is a pnpm monorepo with three services (Vite frontend, Express API, Python FastAPI) deployed to an AWS Lightsail instance via SSH. The deployment workflow was modeled after the biomapper2 project's working `deploy-api.yml`, but the multi-service nature and shared-server environment introduced five distinct failure modes that required iterative fixes across five deploy attempts before achieving a green build.

The core challenge: SSH-based deploys to persistent VMs have a much larger surface area of assumptions than containerized deploys. Port conflicts, long-lived venvs, certbot-managed configs, platform-specific workspaces, and the interaction between SSH action options and bash error handling all create non-obvious failure modes invisible in local testing.

## Guidance

### 1. Don't use `corepack enable` in deploy scripts

`corepack enable` creates symlinks in `/usr/bin/` which requires root. In non-interactive SSH sessions (like GitHub Actions), this fails with `EACCES: permission denied`. Since pnpm is installed once during initial server setup, the deploy script doesn't need to re-enable it.

```bash
# WRONG - fails without sudo
corepack enable
pnpm install --frozen-lockfile

# RIGHT - pnpm already available from initial setup
pnpm install --frozen-lockfile
```

### 2. Use filtered workspace builds, not root build

A root `pnpm build` builds every workspace, including dev-only or platform-specific ones. biomapper-ui's `mockup-sandbox` workspace requires Replit-specific env vars (`PORT`, `BASE_PATH`) that don't exist on the server.

```bash
# WRONG - builds everything, fails on dev-only workspaces
pnpm build

# RIGHT - only production workspaces
pnpm run typecheck
PORT=5173 BASE_PATH="/" pnpm --filter @workspace/frontend run build
pnpm --filter @workspace/api-server run build
```

### 3. Don't recreate existing Python venvs

`uv venv` exits non-zero if `.venv/` already exists. On a persistent server the venv is long-lived between deploys. Just sync dependencies.

```bash
# WRONG - fails when venv exists
~/.local/bin/uv venv .venv --python 3.11
~/.local/bin/uv pip install -r requirements.txt

# RIGHT - sync only, works with existing or new venv
~/.local/bin/uv pip install --python .venv/bin/python -r requirements.txt
```

Note: `uv` may not be on `$PATH` — use the full path (`~/.local/bin/uv`).

### 4. Don't use `script_stop: true` with retry loops

`appleboy/ssh-action`'s `script_stop: true` wraps each command individually and checks exit codes at the action level, **overriding** any `set +e` in the script body. This silently kills health-check retry loops on the first `curl` failure.

```yaml
# WRONG - script_stop overrides set +e, breaks retry loops
- uses: appleboy/ssh-action@<sha>
  with:
    script_stop: true
    script: |
      set +e          # THIS GETS OVERRIDDEN
      for i in $(seq 1 12); do
        curl -sf http://localhost:8002/health && break
        sleep 5
      done

# RIGHT - manage error handling in the script itself
- uses: appleboy/ssh-action@<sha>
  with:
    # no script_stop
    script: |
      set -e
      # ... deploy steps ...
      set +e
      for i in $(seq 1 12); do
        curl -sf http://localhost:8002/health && break
        sleep 5
      done
      set -e
      # ... final verification with set -e ...
```

(session history) This was the most subtle failure — the deploy printed "Waiting for services to start..." and then exited without any loop output, making it look like a timeout when it was actually an immediate exit on the first curl failure.

### 5. Export only VITE_* vars, not the entire .env

Sourcing the full `.env` leaks backend secrets (API keys, Clerk secret keys) into the build environment where postinstall scripts and build plugins can access them.

```bash
# WRONG - exposes all secrets to build process
set -a; source .env; set +a
pnpm build

# RIGHT - surgical export of only frontend vars
set -a; source <(grep '^VITE_' "$DEPLOY_DIR/.env" 2>/dev/null); set +a
pnpm --filter @workspace/frontend run build
```

### 6. Use `cancel-in-progress: false` for SSH deploys

When a new push cancels a running deploy, the SSH connection is killed mid-script. This can leave the server after `git reset --hard` but before the build completes, or after `systemctl restart` but before health checks pass.

```yaml
concurrency:
  group: deploy-production
  cancel-in-progress: false   # queue, don't kill
```

### 7. Never copy nginx config in CI when certbot manages SSL

Certbot modifies the live nginx config to add SSL listeners, certificate paths, and HTTP-to-HTTPS redirects. Copying the repo template overwrites these additions, breaking HTTPS on every deploy.

```bash
# WRONG - destroys certbot's SSL config
sudo cp deploy/nginx-link.conf /etc/nginx/sites-available/link.conf
sudo systemctl reload nginx

# RIGHT - only update systemd services, leave nginx alone
sudo cp deploy/biomapper-ui-express.service /etc/systemd/system/
sudo cp deploy/biomapper-ui-python.service /etc/systemd/system/
sudo systemctl daemon-reload
```

### 8. Pin GitHub Actions by commit SHA

Tags are mutable. A compromised upstream can re-tag to inject malicious code that runs with your SSH key.

```yaml
# WRONG - mutable tag
- uses: appleboy/ssh-action@v1.0.3

# RIGHT - immutable SHA
- uses: appleboy/ssh-action@029f5b4aeeeb58fdfe1410a5d17f967dacf36262 # v1.0.3
```

## Why This Matters

Each of these eight patterns was discovered through a deploy failure or security review. The five-attempt deploy sequence demonstrates that CI/CD for a multi-service app on a shared server has failure modes that are invisible in local testing and not covered by the simpler single-service deploy patterns (like biomapper2's working workflow that this was modeled after). Documenting these prevents the next project on this server from repeating the same debugging cycle.

## When to Apply

- Deploying to a persistent VM via SSH (not containers)
- Multi-service apps sharing a single host with other projects
- pnpm/npm workspaces where some workspaces are platform-specific
- Any server where certbot or similar has modified config files in-place
- Using `appleboy/ssh-action` or similar SSH-based GitHub Actions

## Examples

### Server Audit Checklist (Run Before Writing the Workflow)

Before writing a single line of YAML, SSH into the server and record:

| Check | Command | Why |
|-------|---------|-----|
| Port inventory | `ss -tlnp` | Find occupied ports — don't assume defaults |
| Tool paths | `which pnpm node uv` | May need full paths if not on `$PATH` |
| Existing venvs | `ls -la .venv/` | Location may differ from repo structure |
| nginx state | `grep -c certbot /etc/nginx/sites-enabled/*` | Don't overwrite certbot config |
| Current branch | `git branch --show-current` | Server may be on old branch |
| Env file audit | `sort .env \| uniq -d` | Check for duplicate keys |
| systemd services | `cat /etc/systemd/system/biomapper-ui-*.service` | Check for hardcoded `Environment=` vs `EnvironmentFile=` |

### biomapper-ui Specifics

| Item | Expected | Actual (discovered) |
|------|----------|-------------------|
| Python API port | 8000 | **8002** (8000 is kraken-chatbot) |
| Python venv path | `artifacts/python-api/.venv/` | **`~/biomapper-ui/.venv/`** (repo root) |
| `uv` location | On PATH | **`~/.local/bin/uv`** |
| Express health endpoint | `/api/health` | **`/api/healthz`** |
| VITE_CLERK_* vars | In .env | **Missing** (Clerk auth disabled) |

## Related

- `docs/solutions/developer-experience/biomapper-ui-deploy-cycle-2026-04-23.md` — initial manual deployment lessons (port conflicts, Clerk auth, ProtectHome bug)
- `docs/solutions/runtime-errors/systemd-protecthome-breaks-sibling-service-cache-2026-04-23.md` — systemd security hardening pitfall
- `docs/plans/2026-04-27-002-feat-github-actions-lightsail-deploy-plan.md` — implementation plan for this workflow
- `.github/workflows/deploy.yml` — the final working workflow
- PR #3: `feat/github-actions-deploy` — initial implementation
