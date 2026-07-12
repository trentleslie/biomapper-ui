---
title: "Feedback API endpoints missing auth and leaking PII"
date: 2026-05-18
category: security-issues
module: biomapper-ui-feedback-processing
problem_type: security_issue
component: authentication
severity: high
symptoms:
  - "GET /feedback exposed all user emails (PII) to any unauthenticated caller"
  - "POST /feedback accepted submissions with no identity verification"
  - "Email masking produced malformed output (double @ sign) for short local parts"
  - "API key comparison used != operator (timing attack vulnerability)"
  - "GET endpoint returned unbounded responses with no LIMIT clause"
root_cause: missing_permission
resolution_type: code_fix
tags:
  - api-security
  - pii
  - access-control
  - timing-attack
  - email-masking
  - feedback-endpoint
  - hmac
  - fastapi
---

# Feedback API endpoints missing auth and leaking PII

## Problem

A multi-persona document review of the feedback mechanism plan revealed that both `POST /feedback` and `GET /feedback` endpoints had no authentication, exposing user emails (PII) to any caller. Additional issues included timing-vulnerable API key comparison, malformed email masking, unbounded GET responses, and URL capture leaking sensitive query parameters.

## Symptoms

- `POST /feedback` accepted submissions from any caller with no `x-clerk-user-id` header check, despite the UI requiring Clerk auth
- `GET /feedback` returned all feedback entries including user emails to any unauthenticated caller — no API key or role restriction
- Server logs printed raw user emails (`feedback.user_email`) on every submission
- Email masking logic `user_email[:3] + "...@" + user_email.split("@")[-1]` produced `ab@...@example.com` for addresses like `ab@example.com`
- GET endpoint had no `LIMIT` clause, returning the entire feedback table in one response
- Frontend captured `window.location.href` including query strings that could contain session tokens or sensitive parameters

## What Didn't Work

- **Environment-only restriction on GET** (session history): The dev branch approach restricted `GET /feedback` to `ENVIRONMENT != production`, blocking the endpoint entirely in production. This was abandoned because downstream processing scripts need production access to pull feedback data for GitHub Issues sync and annotation export. Discarded in merge conflict resolution (commit `42fa54f`).

- **Naive string slicing for email masking** (session history): The first implementation `user_email[:3]` sliced the full address string, not the local part. For `ab@example.com`, `[:3]` yields `ab@`, producing the malformed output `ab@...@example.com` with two `@` signs. Caught by Greptile review.

- **Direct string equality for API key** (session history): The initial `x_api_key != _FEEDBACK_API_KEY` comparison short-circuits on the first mismatched byte, enabling timing-based side-channel attacks to enumerate the key. Caught by Greptile review.

## Solution

### 1. Auth on POST — Clerk user ID header

Match the existing `jobs.py` pattern: require `x-clerk-user-id` header forwarded by the frontend proxy from the authenticated Clerk session.

```python
# routes/feedback.py
@router.post("")
async def submit_feedback(
    feedback: FeedbackRequest,
    x_clerk_user_id: str | None = Header(None),
) -> JSONResponse:
    if x_clerk_user_id is None:
        raise HTTPException(status_code=400, detail="Missing x-clerk-user-id header")
    # ... save and respond
```

### 2. Auth on GET — constant-time API key comparison

Restrict GET to downstream processing scripts via `FEEDBACK_API_KEY` env var with `hmac.compare_digest`:

```python
import hmac, os

_FEEDBACK_API_KEY = os.environ.get("FEEDBACK_API_KEY", "")

@router.get("")
async def list_feedback(
    category: str | None = Query(None, pattern="^(annotation_issue|feature_request|ui_error)$"),
    limit: int = Query(100, ge=1, le=1000),
    x_api_key: str | None = Header(None),
) -> list[dict]:
    if not _FEEDBACK_API_KEY or not x_api_key or not hmac.compare_digest(x_api_key, _FEEDBACK_API_KEY):
        raise HTTPException(status_code=401, detail="Invalid or missing API key")
    return await feedback_store.query(category=category, limit=limit)
```

The explicit `not x_api_key` guard prevents `compare_digest` from receiving `None` (which would raise `TypeError`).

### 3. Email masking — partition on @

```python
# Before (broken):
masked = feedback.user_email[:3] + "...@" + feedback.user_email.split("@")[-1]
# "ab@example.com" → "ab@...@example.com" (double @)

# After (correct):
local, sep, domain = feedback.user_email.partition("@")
masked = local[:3] + "...@" + domain if sep else local[:3] + "..."
# "ab@example.com" → "ab...@example.com"
# "researcher@phenome.org" → "res...@phenome.org"
```

`str.partition("@")` always returns exactly three parts and never includes the separator in the domain portion.

### 4. GET endpoint LIMIT clause

```python
# Route: add limit param with bounds
limit: int = Query(100, ge=1, le=1000)

# SQL: append LIMIT to both filtered and unfiltered queries
"SELECT * FROM feedback WHERE category = ? ORDER BY created_at DESC LIMIT ?"
"SELECT * FROM feedback ORDER BY created_at DESC LIMIT ?"
```

### 5. URL capture — pathname only

```typescript
// Before:
setPageUrl(window.location.href);  // includes ?token=... fragments

// After:
setPageUrl(window.location.pathname);  // path only, no sensitive params
```

## Why This Works

The root cause was **missing access control** — endpoints were implemented without auth, and the plan was retroactively improved through document review but the code hadn't been updated to match.

- The API key approach was chosen over environment restriction because downstream batch processing scripts need production access. The env-only approach would have broken the planned GitHub Issues sync and annotation export workflows.
- `hmac.compare_digest()` is Python's standard library constant-time comparison — eliminates the timing side channel that `!=` creates.

## Prevention

- **Auth-by-default for new routes**: Copy the `x-clerk-user-id` header check from `jobs.py` as a starting template for all new POST endpoints. Don't add auth as an afterthought.
- **Use `hmac.compare_digest` for all secret comparisons**: Flag direct string equality (`==`, `!=`) on values from env vars or headers during code review. This is a standard OWASP recommendation.
- **Centralize PII masking**: Extract a `mask_email(addr: str) -> str` helper so the partition pattern is tested once and reused across logging call sites.
- **Pathname-only convention for logging**: Establish that only `window.location.pathname` (never `href`) is sent to backend logging or analytics endpoints.
- **Mandatory LIMIT on SELECT in API handlers**: All `SELECT` statements in API route handlers should include an explicit `LIMIT` clause, enforced at review time.
- **Greptile review catches security gaps** (auto memory [claude]): The timing attack and email masking bugs were both caught by automated Greptile review on the feature→dev PR. Keep this review step mandatory per the branch workflow.

## Remaining Gaps

- **Email format validation**: `user_email` in `FeedbackRequest` uses `str` with `max_length=254` but no format validation (`EmailStr` or regex). An attacker can submit arbitrary strings as the email field. Consider adding `pydantic[email]` with `EmailStr` or a `pattern=` constraint.

## Related Issues

- PR #18: `fix(feedback): harden security and improve plan-code consistency` — the PR containing these fixes
- PR #16: `feat(feedback): add in-app feedback mechanism` — original implementation (3 rounds of Greptile review caught initial auth gaps)
- `AGENT_PROMPT_feedback_processing.md` — downstream processing workflows that require production GET access (the reason API key auth was chosen over environment restriction)
- `docs/plans/2026-05-17-001-feat-in-app-feedback-mechanism-plan.md` — plan document updated during review to resolve auth strategy, connection model, and UX decisions
