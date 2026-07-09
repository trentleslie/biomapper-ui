---
title: "Cloudflare 1010 blocks urllib User-Agent on Outline API calls"
date: 2026-06-16
category: integration-issues
module: outline_publish
problem_type: integration_issue
component: tooling
symptoms:
  - "POST to Outline /api/collections.create returns HTTP 403 Forbidden"
  - "Response body is a Cloudflare 'Error 1010: Access denied' page, not an Outline JSON error"
  - "Identical request succeeds via curl but 403s via Python urllib"
  - "auth.info works with curl, masking the issue as a token/permission problem"
root_cause: config_error
resolution_type: code_fix
severity: medium
related_components:
  - tooling
  - authentication
tags:
  - outline
  - cloudflare
  - user-agent
  - urllib
  - waf
  - api-integration
  - curl
---

# Cloudflare 1010 blocks urllib User-Agent on Outline API calls

## Problem

A Python helper (`~/.local/bin/outline_publish.py`) posts to the self-hosted Outline wiki at `https://phwiki.phenoma.ai` through its REST API (`/api/collections.create`, `/api/documents.create`, etc.) using `urllib.request`. Every POST returned **HTTP 403 Forbidden**, even though the API token was known-good and read-only endpoints worked when called another way. The 403 was not an Outline authorization error; it was a **Cloudflare edge WAF block (Error 1010, "Access denied")** triggered by the default Python urllib User-Agent, so the request never reached Outline's auth layer.

## Symptoms

- `urllib.request` POST to any Outline endpoint returns `HTTP 403 Forbidden`.
- The same token authenticates fine via `curl` — e.g. `/api/auth.info` returns valid JSON.
- Reading the raw error body reveals a Cloudflare HTML page, not Outline JSON:

  ```
  Error 1010: Access denied
  The owner of this website (phwiki.phenoma.ai) has banned your access
  based on your browser's signature.
  ```
- The failure is consistent across *all* endpoints (read and write alike) from urllib, which is inconsistent with a per-permission or per-scope auth problem.
- The outgoing request carries `User-Agent: Python-urllib/3.x`.

## What Didn't Work

The initial (wrong) hypothesis was an **Outline-layer permissions/auth problem**:

- Suspected the token's scope, or that the authenticated user is a `member` rather than an `admin` and therefore could not create collections/documents.
- Probed `/api/collections.list` and `/api/collections.create`, expecting Outline's own `authorization_error` JSON to confirm a permission gap.
- Treated "writes 403, but reads via curl succeed" as evidence of a write-permission restriction.

This was a **red herring** — the 403 was generated at the Cloudflare edge and never reached Outline. The breakthrough was reading the raw 403 response body:

```python
try:
    resp = urllib.request.urlopen(req)
except urllib.error.HTTPError as e:
    print(e.read().decode())   # <-- revealed Cloudflare "Error 1010", not Outline JSON
```

The body was a Cloudflare HTML block page, not an Outline JSON error, proving it was never an auth/permission issue.

## Solution

Route every Outline API call through `curl` via `subprocess` (whose default UA Cloudflare allows), or equivalently set a browser User-Agent header on the urllib request. The verified-working helper uses curl with an explicit browser UA:

```python
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

def api(endpoint, payload, token):
    proc = subprocess.run(
        ["curl", "-s", "--max-time", "60", "-X", "POST", f"{BASE}/{endpoint}",
         "-H", f"Authorization: Bearer {token}",
         "-H", "Content-Type: application/json",
         "-H", "Accept: application/json",
         "-A", UA,
         "--data", "@-"],
        input=json.dumps(payload), capture_output=True, text=True)
    data = json.loads(proc.stdout)   # raises on a Cloudflare HTML page => surfaces the block clearly
    if not data.get("ok"):
        raise SystemExit(f"{endpoint} error: {json.dumps(data)[:300]}")
    return data["data"]
```

Setting a browser UA is the load-bearing change; using curl is one convenient way to get an allowed default UA plus clear failure surfacing. If staying on urllib, the minimal fix is the same header:

```python
req = urllib.request.Request(url, data=body, headers={
    "Authorization": f"Bearer {token}",
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": UA,   # browser UA; bypasses the Cloudflare 1010 UA filter
})
```

## Why This Works

Cloudflare's edge bot-protection (the rule behind Error 1010) bans requests whose signature matches the default `Python-urllib/3.x` User-Agent; `curl`'s default UA is on the allowed side. The block happens at Cloudflare's edge **before** the request is proxied to Outline, which is why the token is irrelevant to the outcome (it is never evaluated), read-vs-write and member-vs-admin distinctions do not matter (Outline's auth layer is never reached), and switching the transport/UA — not the credentials — is what fixes it. Parsing the response as JSON is a deliberate second benefit: a Cloudflare HTML page fails to parse and surfaces the real cause loudly instead of being mistaken for an API error.

## Prevention

- **Read the response body before concluding "auth failure" on any 403 from an API behind Cloudflare or a WAF.** The discriminator is the body: a Cloudflare `Error 1010` HTML page means an edge block; the API's own JSON error (e.g. Outline's `authorization_error`) means a real permission problem. Do not infer from the status code alone.
- **The "works in curl, 403 in urllib/requests-default" signature points at User-Agent filtering, not credentials.** If the same token succeeds via curl but fails from a Python client, suspect the UA before suspecting scope or role.
- **For scripted API clients behind Cloudflare, set an explicit browser User-Agent** (or shell out to curl). Do not ship a client relying on the default `Python-urllib/*` UA against a Cloudflare-fronted host.
- **Parse responses as the expected content type (JSON).** Letting a non-JSON Cloudflare page raise on parse makes edge blocks fail loudly rather than masquerading as API errors.

## Related Issues

- Consumer of this fix: the `/publish-wiki` command (`~/.claude/commands/publish-wiki.md`) and helper `~/.local/bin/outline_publish.py`. The instance reference (API base, token path, endpoints, and this gotcha) lives in the `/servers` command (`~/.claude/commands/servers.md` → "Phenome Wiki").
- The gotcha is also recorded in the `project_wiki_publishing.md` auto-memory note (auto memory [claude]).
- Distinct surface, do not conflate (session history): network access to the wiki VM itself uses a *separate* Cloudflare path — Cloudflare WARP plus the SSH alias `phenome-wiki-vm`. That is a transport/VPN layer to the host and is unrelated to this HTTP edge User-Agent block on the public API.
