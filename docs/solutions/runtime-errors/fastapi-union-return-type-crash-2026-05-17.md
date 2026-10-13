---
title: FastAPI crashes on union return type annotation with Response class
date: 2026-05-17
category: runtime-errors
module: python-api
problem_type: runtime_error
component: service_object
symptoms:
  - "Python API fails health check after deployment (never becomes healthy)"
  - "fastapi.exceptions.FastAPIError: Invalid args for response field! Hint: check that dict | starlette.responses.JSONResponse is a valid Pydantic field type"
  - "Service crash-loops with systemd restart, never serving requests"
root_cause: wrong_api
resolution_type: code_fix
severity: high
tags:
  - fastapi
  - deployment
  - return-type
  - pydantic
  - uvicorn
  - systemd
---

# FastAPI crashes on union return type annotation with Response class

## Problem

After deploying a new endpoint with `-> dict | JSONResponse` return type annotation, the Python API (uvicorn + FastAPI) crashes at startup and never passes health checks. The service crash-loops under systemd, blocking the entire deployment.

## Symptoms

- Deployment health check times out (Python=false for all 12 retry attempts)
- `journalctl -u biomapper-ui-dev-python` shows FastAPIError at module load time
- Error: `Invalid args for response field! Hint: check that dict | starlette.responses.JSONResponse is a valid Pydantic field type`
- Express API is healthy (Express=true) but Python API never starts

## What Didn't Work

- **Lazy asyncio.Semaphore initialization**: Assumed the crash was from creating `asyncio.Semaphore()` at module level before the event loop existed. This was not the issue — Python 3.10+ doesn't bind primitives to a loop at creation.
- **Making CSV loading non-fatal**: Assumed the crash was from `RuntimeError` during CSV file parsing at import time. Made it log-and-continue instead of raising. Server still crashed because the real issue was in the route decorator, not the CSV loading.
- **No `journalctl` in deploy script**: The first two debugging attempts were blind — the deploy script only reported "health check failed" without the actual Python traceback. Adding `sudo journalctl -u <service> -n 50` to the failure handler revealed the real error immediately.

## Solution

Remove the union return type annotation and use `response_model=None` on the decorator:

```python
# BEFORE — crashes FastAPI at import time
@router.post("/demo")
async def start_demo(background_tasks: BackgroundTasks) -> dict | JSONResponse:
    ...

# AFTER — works correctly
@router.post("/demo", response_model=None)
async def start_demo(background_tasks: BackgroundTasks):
    ...
```

## Why This Works

FastAPI uses return type annotations to auto-generate a response model (Pydantic schema for OpenAPI docs and validation). When it encounters `dict | JSONResponse`, it tries to create a Pydantic field that validates against that union — but `JSONResponse` (a Starlette Response subclass) is not a valid Pydantic type.

The `response_model=None` parameter tells FastAPI to skip response model generation entirely, which is appropriate when an endpoint may return different response types (e.g., a dict on success, a JSONResponse with custom status code on error).

This is a **startup-time crash** because FastAPI processes all route decorators at import time (when `@router.post(...)` executes), not at request time.

## Prevention

- **Never use `Response` subclasses in return type annotations** for FastAPI endpoints. Use `response_model=None` when the endpoint returns mixed types.
- **Add `journalctl` output to deploy health check failures** — blind debugging of service crashes wastes multiple deploy cycles. The deploy script should always surface the last N lines of the service journal on failure.
- **Test FastAPI endpoint imports locally** before pushing: `python -c "from routes.demo import router"` would have caught this immediately.

## Related Issues

- FastAPI docs: https://fastapi.tiangolo.com/tutorial/response-model/#disable-response-model
- Also discovered: Express auth middleware (`requireMapAuth`) gates all `/api/map/*` routes — new unauthenticated endpoints need explicit exemption in the Express proxy layer.
