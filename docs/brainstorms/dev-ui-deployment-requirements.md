---
date: 2026-05-01
topic: dev-ui-deployment
---

# Dev UI Deployment Alongside Production

## Problem Frame

biomapper-ui has a single deployment at `link.expertintheloop.io` that auto-deploys from `main`. There is no way to test UI or deployment changes at a real URL before they hit production. The recent 5-iteration deploy debugging cycle (5 fix commits to get a green build) demonstrates the need for a safe environment to validate deployment changes. A persistent `dev` branch with its own deployment also serves as a troubleshooting sandbox for deployment pipeline work.

## Requirements

**Dev Instance Infrastructure**
- R1. A second full biomapper-ui instance (frontend + Express API + Python API) running on Lightsail at `dev-link.expertintheloop.io`
- R2. Dev instance uses dedicated ports (Express :8004, Python :8005) separate from production (:8080, :8002)
- R3. Dev instance code lives at `/home/ubuntu/biomapper-ui-dev/` with its own `.env` and `.venv/`
- R4. Dev instance has its own systemd service units (`biomapper-ui-dev-express.service`, `biomapper-ui-dev-python.service`)
- R5. nginx site config with certbot SSL for `dev-link.expertintheloop.io`

**Deployment Pipeline**
- R6. Auto-deploy from the persistent `dev` branch on push (GitHub Actions)
- R7. Manual `workflow_dispatch` with a branch name input to deploy any branch to the dev instance
- R8. Deploy workflow applies all lessons from the production deploy cycle (no corepack enable, filtered workspace builds, no venv recreation, no script_stop with retry loops, VITE_* only exports, no nginx overwrite)

**Branch Model**
- R9. Persistent `dev` branch as the primary development/troubleshooting branch
- R10. Dev branch auto-deploys to the dev instance; `main` continues to auto-deploy to production

## Success Criteria

- Dev instance accessible at `https://dev-link.expertintheloop.io` serving the biomapper-ui frontend with working Express and Python APIs
- Pushing to `dev` branch triggers automatic deployment to the dev instance without affecting production
- Manual dispatch can deploy any feature branch to the dev instance
- Production deployment (`main` -> `link.expertintheloop.io`) is completely unaffected

## Scope Boundaries

- Dev instance shares the Lightsail server with production (same machine, different ports/directory)
- No changes to the production deploy workflow or `main` branch pipeline
- The existing dev-biomapper.expertintheloop.io (:8003) for biomapper2-dev is untouched
- No separate database or persistent storage needed (biomapper-ui is stateless aside from .env config)
- Dev instance `.env` can default to pointing at the dev biomapper2 API (:8003) but this is a config choice, not a hard requirement

## Key Decisions

- **New subdomain over reusing dev-biomapper**: `dev-link.expertintheloop.io` keeps the naming consistent (`link` = biomapper-ui) and avoids confusion with the existing biomapper2 dev API
- **Persistent `dev` branch over feature branches**: Provides a stable auto-deploy target and a safe troubleshooting environment. Feature branches deploy via manual dispatch.
- **Separate workflow file over environment matrix**: Keeps prod and dev deploy configs independent — a broken dev deploy config can't accidentally break prod deploys

## Dependencies / Assumptions

- Lightsail has capacity: ports 8004-8005 are free, ~125GB disk free, ~6GB RAM available
- DNS for `dev-link.expertintheloop.io` needs to be pointed at the Lightsail IP (or the existing wildcard if one exists)
- GitHub Actions secrets (`LIGHTSAIL_HOST`, `LIGHTSAIL_SSH_KEY`) are already configured from the production workflow

## Outstanding Questions

### Deferred to Planning
- [Affects R5][Needs research] Does `*.expertintheloop.io` have a wildcard DNS record, or does `dev-link` need a new A record?
- [Affects R3][Technical] Should the dev `.env` share API keys with production or use separate dev keys?
- [Affects R4][Technical] Set `UV_CACHE_DIR` per-service or per-deploy to avoid race conditions on `~/.cache/uv/` during simultaneous prod+dev deploys
- [Affects R6][Technical] Dev deploy workflow needs its own concurrency group (`deploy-dev`) separate from production's `deploy-production`

## Next Steps

-> `/ce:plan` for structured implementation planning
