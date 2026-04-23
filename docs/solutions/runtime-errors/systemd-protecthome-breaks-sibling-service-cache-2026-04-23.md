---
title: "systemd ProtectHome=read-only breaks sibling service uv cache"
date: 2026-04-23
category: runtime-errors
module: deployment
problem_type: runtime_error
component: tooling
severity: high
symptoms:
  - "biomapper2-api crash-loops immediately after biomapper-ui is deployed (600+ restarts)"
  - "uv reports 'Read-only file system (os error 30) at path ~/.cache/uv/.tmp'"
  - "Sibling service fails despite no changes to its own code or config"
root_cause: config_error
resolution_type: config_change
tags: [systemd, protecthome, uv, deployment, lightsail, multi-service, cache]
---

# systemd ProtectHome=read-only breaks sibling service uv cache

## Problem

After deploying biomapper-ui to a shared AWS Lightsail instance, the pre-existing biomapper2-api service entered a crash loop (600+ restarts). The biomapper2 code and config had not changed — the failure was caused by biomapper-ui's systemd service using `ProtectHome=read-only`, which made `~/.cache/uv/` read-only for all services running as the same user.

## Symptoms

- biomapper2-api crash-loops immediately after biomapper-ui services are started
- journalctl shows: `error: Could not acquire lock — Caused by: Read-only file system (os error 30) at path "/home/ubuntu/.cache/uv/.tmp..."`
- Restart counter exceeds 600 with no recovery
- The biomapper-ui services themselves appear healthy
- Root cause is non-obvious because the failing service's unit file has not changed

## What Didn't Work

- **Checking biomapper2's own config** — nothing changed in its service file, env, or code (session history)
- **`fuser -k` and `kill -9` on port 8001** — the crash wasn't a port conflict; the process died before binding
- **Initial ReadWritePaths fix without stop/reset** — daemon-reload during rapid crash-loop didn't pick up the config change; the service kept restarting with the old config

## Solution

Add the uv cache directory and `/tmp` to biomapper2's `ReadWritePaths` in its systemd service file:

```ini
# Before (in /etc/systemd/system/biomapper2-api.service):
ReadWritePaths=/home/ubuntu/biomapper2/results /home/ubuntu/biomapper2/cache

# After:
ReadWritePaths=/home/ubuntu/biomapper2/results /home/ubuntu/biomapper2/cache /home/ubuntu/.cache/uv /tmp
```

Then stop, reset, reload, and restart (not just restart — the crash loop must be broken first):

```bash
sudo systemctl stop biomapper2-api
sudo systemctl reset-failed biomapper2-api
sudo systemctl daemon-reload
sudo systemctl start biomapper2-api
```

## Why This Works

`ProtectHome=read-only` applies a read-only bind mount over `/home` in the service's mount namespace. When multiple services run under the same user (`ubuntu`), the mount namespace restrictions interact. `uv` stores its cache at `~/.cache/uv/` and requires write access during `uv run` — even when no packages need installing (lock file writes, temp artifact staging). Adding the cache path to `ReadWritePaths` explicitly grants write access, overriding the inherited read-only mount.

The service had been stable for months because uv's cache was already populated. The deployment triggered cache invalidation (fresh uv install on the same host), and the next restart of biomapper2 hit the now-read-only cache path.

## Prevention

1. **When adding `ProtectHome=read-only` to any service**, audit ALL writable paths needed by the process and every tool it invokes — including package manager caches:

   | Tool | Default cache path |
   |------|--------------------|
   | uv | `~/.cache/uv/` |
   | pip | `~/.cache/pip/` |
   | npm | `~/.npm/_cacache/` |
   | cargo | `~/.cargo/registry/` |
   | go | `~/.cache/go/` |
   | poetry | `~/.cache/pypoetry/` |

2. **When multiple services share a user**, treat `ProtectHome` as cross-service. Document shared-user services and their filesystem dependencies together.

3. **Test service restarts after adding security hardening**, not just first-time starts. Crash loops from hardening often only appear on restart paths when caches need regeneration.

4. **When a crash loop is in progress**, `systemctl stop` + `reset-failed` + `daemon-reload` before starting. A plain `restart` during rapid crash-looping may not pick up config changes.

## Related Issues

- Cross-ref: `docs/solutions/developer-experience/biomapper-ui-deploy-cycle-2026-04-23.md`
- Deploy config files: `deploy/biomapper-ui-python.service`, `deploy/biomapper-ui-express.service`
