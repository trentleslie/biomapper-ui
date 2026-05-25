---
title: "feat: Add In-App Feedback Mechanism"
type: feat
status: active
date: 2026-05-17
---

# feat: Add In-App Feedback Mechanism

## Overview

Add a floating feedback button (FAB) visible on all authenticated pages that opens a categorized feedback form. Users can report annotation issues, request features, or flag UI errors. Feedback is stored in a local SQLite database with context auto-captured from the current page, and retrievable via a category-filtered GET endpoint for downstream processing (GitHub Issues, spreadsheet export).

## Problem Frame

Biomapper UI researchers currently have no in-app channel to report issues or request features — they resort to email or Slack, which creates scattered, unstructured feedback. A lightweight always-available feedback mechanism reduces friction and captures structured, contextual reports.

## Requirements Trace

**Frontend UI**
- R1. Floating feedback button visible on all authenticated pages (bottom-right, non-obstructive)
- R2. Categorized feedback form: Annotation Issue, Feature Request, UI Error
- R3. Category-specific fields (expected result, steps to reproduce, auto-context)
- R8. UX polish: dismiss via Escape/click-outside, loading state, success toast, form reset

**Backend Persistence & API**
- R4. Context auto-capture: page URL, job ID (when on /job/:jobId), user agent
- R5. POST /feedback endpoint with structured schema
- R6. SQLite persistence with UUID and timestamp per entry
- R9. GET /feedback endpoint with category filtering for downstream processing

**Logging & Confirmation**
- R7. Submission confirmation: server logs to stdout with category and user email; client displays success toast ("Feedback submitted — thank you!") after 201 response. Error toast on submission failure displays "Unable to submit feedback. Please try again."

## Scope Boundaries

- No screenshot attachment (stretch goal, deferred)
- No email/SMTP notification (stdout logging only for now)
- No admin UI to view/manage feedback entries
- No rate limiting or spam prevention
- Compound name auto-capture deferred — no clean way to capture without adding selection state to the results table

### Deferred to Separate Tasks

- **Feedback processing workflows**: GitHub Issues sync for bugs/features, Google Sheets or CSV export for annotation issues — documented in `AGENT_PROMPT_feedback_processing.md` for a follow-up feature branch

## Context & Research

### Relevant Code and Patterns

- `artifacts/frontend/src/components/AppShell.tsx` — layout shell, FAB placement target
- `artifacts/frontend/src/components/ui/dialog.tsx` — Radix Dialog for modal
- `artifacts/frontend/src/hooks/use-toast.ts` — toast pattern for success confirmation
- `artifacts/frontend/src/pages/dashboard.tsx` — source for job ID context (from URL params)
- `artifacts/python-api/main.py` — router registration pattern (`app.include_router`)
- `artifacts/python-api/routes/map.py` — reference for route structure
- `artifacts/python-api/models/schemas.py` — Pydantic model patterns with camelCase alias
- `artifacts/python-api/services/jobs.py` — reference for service class patterns
- Clerk: `useUser()` provides `user?.primaryEmailAddress?.emailAddress`
- Wouter: `useRoute()` or `useLocation()` for current path

### Institutional Learnings

- No relevant `docs/solutions/` entries for this feature area.

## Key Technical Decisions

- **Dialog over Sheet**: Use shadcn `Dialog` for the feedback form — it's centered and feels more like a quick action than a side panel. Sheet would work but Dialog matches the "quick report" mental model better.
- **SQLite over JSON file**: SQLite provides atomic writes, query capability, and avoids file corruption risks under concurrent access. The `aiosqlite` library integrates cleanly with FastAPI's async model.
- **Context from URL params + Wouter**: Job ID comes from Wouter's route params (already parsed in dashboard). Page URL from `window.location`. No need for global state.
- **Controlled form state (useState)**: The existing codebase uses `useState` for forms rather than React Hook Form. Follow the same pattern for consistency and simplicity.
- **No separate API client generation**: This is a single endpoint. Import `customFetch` directly from `lib/api-client-react/src/custom-fetch` — no barrel export modification needed for a single internal consumer. `customFetch` auto-injects `x-biomapper-env` header and handles base URL resolution. No raw `fetch()` and no orval regeneration needed.

## Open Questions

### Resolved During Planning

- **Where does the FAB render?** Inside `AppShell.tsx` as a fixed-position element after the main content area. It renders for all authenticated users regardless of page.
- **How to get job ID on dashboard?** From Wouter's route params — the dashboard URL is `/job/:jobId`, so the job ID is already in the URL.
- **How to get compound name context?** Deferred — the results table has no "selected compound" concept today. Adding selection state is out of scope. Users can manually mention the compound in their description. Captured in Scope Boundaries as a separate task.

### Deferred to Implementation

- Exact animation/transition for FAB hover state — try Framer Motion `whileHover` and adjust visually

### Resolved During Review

- **aiosqlite connection strategy?** Per-operation short-lived connections (`async with aiosqlite.connect(...)` in each save/query call). WAL mode is set once during `init_db()` and persists at the database file level across subsequent connections. No pool or long-lived connection needed at current scale (single-digit concurrent users). This is simpler and avoids connection lifecycle management.

## Implementation Units

- [x] **Unit 1: Backend — Feedback Schema and SQLite Service**

**Goal:** Create the Pydantic model for feedback requests and a service class that initializes the SQLite database and provides insert/query methods.

**Requirements:** R5, R6

**Dependencies:** None

**Files:**
- Modify: `artifacts/python-api/requirements.txt` — add `aiosqlite>=0.20.0`
- Create: `artifacts/python-api/models/feedback.py`
- Create: `artifacts/python-api/services/feedback_store.py`

**Approach:**
- Pydantic model with `category` (Literal enum), `description`, `metadata` (nested model with Optional[str] fields — serialized with `exclude_none=True` on `model_dump()` so only non-null fields appear in the JSON column and GET responses)
- `user_email` is accepted from the request body (frontend sends from `useUser()`). Identity verification comes from the `x-clerk-user-id` header (same trust model as jobs.py). No Clerk Python SDK needed — the proxy-forwarded header provides sufficient trust for an internal tool with single-digit users.
- Define explicit max lengths on all string fields: `description` max 5000 chars, each metadata value max 500 chars. Reject requests exceeding limits with HTTP 422
- Service class: `FeedbackStore` with `init_db()` (CREATE TABLE IF NOT EXISTS), `save(feedback)` (INSERT with uuid4 + utcnow timestamp), `query(category=None)` (SELECT with optional category filter)
- Database file path: `artifacts/python-api/data/feedback.db`
- `init_db()` must call `Path(db_path).parent.mkdir(parents=True, exist_ok=True)` before connecting
- Enable WAL mode on connection (`PRAGMA journal_mode=WAL`) for safe concurrent reads
- **Connection strategy:** Per-operation short-lived connections using `async with aiosqlite.connect(...)` in each save/query call. WAL mode persists at the database file level after being set in `init_db()`. No long-lived connection or explicit close needed.
- Table schema: id (TEXT PK), category, description, metadata (JSON TEXT), user_email, created_at (TEXT ISO format)
- Use `aiosqlite` for async SQLite access
- `init_db()` called during FastAPI lifespan startup — add a `lifespan` async context manager to `main.py` (currently has none): `async def lifespan(app): await feedback_store.init_db(); yield` passed as `FastAPI(lifespan=lifespan)`. If DB initialization fails (permission denied, disk full), raise immediately to prevent server from starting in degraded state — the exception propagates through the lifespan and FastAPI logs it clearly.

**Patterns to follow:**
- `artifacts/python-api/models/schemas.py` — Pydantic model conventions (camelCase alias)
- `artifacts/python-api/services/jobs.py` — service class pattern

**Test scenarios:**
- Happy path: save feedback with all fields populated -> returns UUID, retrievable from DB
- Happy path: save feedback with minimal fields (only required) -> stores successfully with null optionals
- Edge case: concurrent saves -> both persist without corruption (SQLite serializes)
- Error path: invalid category value -> Pydantic validation rejects before reaching service

**Verification:**
- Pydantic model validates and rejects malformed input
- SQLite file created on first use, survives server restart

---

- [x] **Unit 2: Backend — Feedback Route**

**Goal:** Create the FastAPI route that accepts feedback submissions, persists them, and logs the event.

**Requirements:** R5, R7, R9

**Dependencies:** Unit 1

**Files:**
- Create: `artifacts/python-api/routes/feedback.py`
- Modify: `artifacts/python-api/main.py`

**Approach:**
- **Authentication (POST):** Require `x-clerk-user-id` header (same pattern as `routes/jobs.py`). Return 400 if missing. The header is forwarded by the frontend proxy from the authenticated Clerk session. `user_email` remains in the request body from the frontend's `useUser()` — the `x-clerk-user-id` header provides identity verification, the email provides contact attribution. This matches the existing trust model where the frontend is trusted to send correct user data alongside the verified user ID.
- **Authorization (GET):** Restricted via `X-API-Key` header checked against `FEEDBACK_API_KEY` environment variable. This endpoint is for downstream processing scripts only, not direct user access. API key must be: generated with high entropy (e.g., `secrets.token_urlsafe(32)`), stored in env var only (never source-controlled or logged), rotated on any suspected exposure.
- `POST /feedback` route accepting the Pydantic model as body
- `GET /feedback` route with optional `?category=annotation_issue|feature_request|ui_error` query param — returns JSON array of feedback entries, most recent first. Include `limit` param (default 100, max 1000) to prevent unbounded responses. **Downstream contract:** Response includes `id`, `category`, `description`, `metadata` (dict of non-null string fields: `page_url`, `job_id`, `user_agent`), `user_email`, `created_at`. This format is designed for downstream processing documented in `AGENT_PROMPT_feedback_processing.md` — changes to response schema require coordination with that task.
- Call `FeedbackStore.save()`, log submission to stdout with category and user email (log email as truncated hash or first 3 chars + domain to reduce PII exposure in logs)
- Return `{ "id": "<uuid>", "status": "received" }` with 201 status
- Register router in `main.py`: `app.include_router(feedback_router.router, prefix="/feedback")`

**Patterns to follow:**
- `artifacts/python-api/routes/map.py` — router structure, response patterns
- `artifacts/python-api/main.py` — router registration

**Test scenarios:**
- Happy path: POST valid feedback with `x-clerk-user-id` header -> 201 with id and status "received"
- Happy path: feedback appears in SQLite after successful POST
- Happy path: GET /feedback with valid `X-API-Key` header -> returns entries as JSON array (up to limit)
- Happy path: GET /feedback?category=ui_error&limit=50 -> returns only ui_error entries, max 50
- Error path: POST without `x-clerk-user-id` header -> 400 "Missing x-clerk-user-id header"
- Error path: GET without valid API key -> 401 "Invalid or missing API key"
- Error path: POST with missing required field (description) -> 422 validation error
- Error path: POST with invalid category -> 422 validation error
- Edge case: GET /feedback with no entries -> returns empty array []
- Edge case: description exceeds 5000 chars -> 422 validation error

**Verification:**
- Endpoint responds to POST /feedback with correct status codes
- Feedback persists across server restarts (SQLite file)
- Server stdout shows log line on submission

---

- [x] **Unit 3: Frontend — FeedbackButton Component (FAB)**

**Goal:** Create the floating action button that appears on all authenticated pages and triggers the feedback dialog.

**Requirements:** R1, R8

**Dependencies:** None (can parallel with backend)

**Files:**
- Create: `artifacts/frontend/src/components/FeedbackButton.tsx`
- Modify: `artifacts/frontend/src/components/AppShell.tsx`

**Approach:**
- Fixed-position button: `fixed bottom-4 right-4 md:bottom-6 md:right-6 z-50`. Breakpoint matches Tailwind's `md:` threshold (768px). Minimum touch target: 48x48px (`h-12 w-12`) to exceed WCAG 2.5.5 minimum of 44x44px.
- Icon-only at rest (`MessageSquarePlus` from lucide-react), semi-transparent (`opacity-70`)
- On hover: full opacity, slight scale-up via Framer Motion or CSS transition
- Manages `open` state for the Dialog
- Render in AppShell after the main content div. AppShell only renders for authenticated users (Clerk's auth guard wraps it), so the FAB is guaranteed to appear only on authenticated pages.

**Patterns to follow:**
- `artifacts/frontend/src/components/AppShell.tsx` — layout structure, z-index layering (header is z-40, FAB should be z-50)
- Button component variants from `components/ui/button.tsx`

**Test scenarios:**
- Happy path: button visible on authenticated page, clickable, opens dialog
- Edge case: button does not overlap footer content or bottom-of-page elements on small viewports
- Happy path: hover state transitions smoothly (opacity + scale)

**Verification:**
- FAB visible on all authenticated pages in bottom-right
- Clicking opens dialog (Unit 4)
- Does not interfere with existing page interactions

---

- [x] **Unit 4: Frontend — FeedbackDialog Component**

**Goal:** Create the categorized feedback form dialog with category-specific fields and context auto-capture.

**Requirements:** R2, R3, R4, R5, R7, R8

**Dependencies:** Unit 2 (backend endpoint), Unit 3 (receives open/onClose props)

**Files:**
- Create: `artifacts/frontend/src/components/FeedbackDialog.tsx`
- Import `customFetch` directly from `lib/api-client-react/src/custom-fetch` (or use the existing barrel export if available) — no modification to the package's `index.ts` needed for a single internal consumer

**Approach:**
- Use shadcn `Dialog` component (DialogContent, DialogHeader, DialogTitle, DialogDescription)
- Category selector using Radix RadioGroup (arrow keys to navigate, Tab to exit — accessible by default). **Default selection:** "Feature Request" pre-selected on dialog open (most common use case; least confusing empty state).
- **User email guard:** If `useUser()` returns null or has no primaryEmailAddress, disable the submit button with a tooltip "You must be logged in to submit feedback." (This should not occur since AppShell requires auth, but guards against stale sessions.)
- Common field: description textarea (required, min 10 chars, max 5000 chars)
  - Character counter always visible below textarea showing "N / 5000"
  - **Validation behavior:** Submit button is always enabled. On submit attempt, if description is too short (< 10 chars), show inline red hint below textarea ("Description must be at least 10 characters") and do NOT submit. This is submit-time validation, not progressive disabling.
- Category-specific fields:
  - Annotation Issue: "Expected result" optional textarea, read-only context disclosure (see below)
  - Feature Request: description only
  - UI Error: "Steps to reproduce" optional textarea, auto-captured user agent (hidden)
- **Category switching behavior:** Description text persists when switching categories. Category-specific fields (expected result, steps to reproduce) reset on switch. This minimizes data loss if a user picks the wrong category.
- **Auto-context capture on open:**
  - `window.location.pathname` for page URL (pathname only — excludes query strings and fragments to avoid capturing sensitive params)
  - Job ID extracted from URL path (`/job/:jobId` pattern) — `null` when not on a job page
  - `navigator.userAgent` for browser info (always available)
- **Context metadata display (Annotation Issue category):** Show a collapsible "Captured context" section (collapsed by default) with read-only text showing page URL and job ID. Trigger is a left-aligned text link ("Show captured context" / "Hide captured context") with a chevron icon that rotates on expand. When job ID is null, show "Page: [url]" only — omit the job ID line entirely rather than showing "N/A"
- **Focus management on open:** Set initial focus to the first RadioGroup option (or the default selected option) using Radix Dialog's `onOpenAutoFocus` or `autoFocus` on the first radio input, so keyboard and screen reader users land on the category selector immediately
- **FAB + dialog layering:** Hide the FAB with `opacity-0 pointer-events-none` (not `display: none`) when dialog is open — Radix Dialog needs the trigger element in the DOM to return focus on close. The Radix portal renders above z-50 by default so visual overlap is unlikely, but the opacity pattern is a safe guard.
- **Dialog scroll:** `overflow-y-auto max-h-[85vh]` on DialogContent — researchers primarily use desktop but this prevents overflow if the keyboard opens on a smaller screen
- Submit handler: use `customFetch` from the API client package to POST `/feedback` with structured payload including user email from `useUser()`
- **Submit button states:** (1) Enabled — default, clickable. (2) Disabled + loading spinner — during active submission. (3) Disabled + tooltip — if `useUser()` has no email (stale session guard). Validation errors (description too short) do NOT disable the button; they show an inline hint and allow retry.
- On success: close dialog, show toast ("Feedback submitted — thank you!"), reset form
- On error: show error toast with specific copy — API error: "Feedback could not be submitted. Please try again." Network failure: "Unable to submit feedback. Check your connection and try again." Dialog stays open, submit button re-enables for retry
- **Keyboard dismissal note:** Escape first closes any open nested Radix primitive (e.g., a popover), then a second Escape closes the dialog. This is standard Radix nesting behavior — no custom handling needed

**Patterns to follow:**
- `artifacts/frontend/src/components/ui/dialog.tsx` — Dialog usage pattern
- `artifacts/frontend/src/hooks/use-toast.ts` — toast usage
- `artifacts/frontend/src/pages/upload.tsx` — form state management with useState
- `lib/api-client-react/src/custom-fetch.ts` — customFetch usage (auto-injects env header)

**Test scenarios:**
- Happy path: select "Feature Request", enter description, submit -> success toast, dialog closes, form resets
- Happy path: select "Annotation Issue" on /job/abc-123 -> job ID auto-populated in metadata
- Happy path: select "UI Error" -> user agent auto-captured without user action
- Edge case: description too short (< 10 chars) -> submit attempt shows inline red hint, submission blocked
- Error path: API returns error -> error toast shown, dialog stays open, form preserved
- Happy path: dismiss via Escape key or click outside -> dialog closes without submission
- Edge case: rapid double-click submit -> only one request sent (button disabled during loading)
- Error path: network failure -> error toast "Unable to submit feedback", submit re-enables
- Integration: env header auto-injected by customFetch matches current environment toggle

**Verification:**
- Form submits successfully for all three categories
- Auto-context fields populated correctly per page
- Success/error states handled with appropriate user feedback
- Dialog dismissal works via all three methods (X button, Escape, click outside)

---

- [x] **Unit 5: End-to-End Verification**

**Goal:** Verify the complete flow works: FAB visible -> open dialog -> fill form -> submit -> see toast -> check persistence.

**Requirements:** R1-R9

**Dependencies:** Units 1-4

**Files:**
- No new files — manual verification

**Approach:**
- Start dev server (frontend + backend)
- Navigate to authenticated page
- Click FAB, submit feedback for each category
- Verify toast appears, dialog closes
- Check SQLite file contains the entries
- Test dismiss behaviors (Escape, click outside)
- Test on dashboard page to verify job ID auto-capture

**Test expectation: none** — this is a manual integration verification step

**Verification:**
- Complete feedback loop works for all three categories
- Context auto-capture populates correctly on dashboard page
- No console errors or unhandled promise rejections

## System-Wide Impact

- **Interaction graph:** FeedbackButton renders inside AppShell, so it's present on every authenticated route. No interaction with existing components beyond layout positioning.
- **Error propagation:** Feedback submission failures are isolated — they show a toast and do not affect other app functionality.
- **State lifecycle risks:** None significant — feedback form is ephemeral state (useState). SQLite writes are atomic.
- **API surface parity:** New `/feedback` endpoint is independent of existing `/map` and `/discovery` endpoints. No shared state.
- **Unchanged invariants:** Existing routing, mapping flow, and dashboard functionality are not modified. The FAB is additive only.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| FAB overlaps content on small screens | Responsive positioning: `bottom-4 right-4` below 768px, `bottom-6 right-6` at md+ breakpoint. Test on mobile viewport. |
| aiosqlite not in existing dependencies | Add to requirements.txt; it's a well-maintained, small package |
| Feedback DB grows unbounded | GET endpoint has `limit` param (default 100). Acceptable for current scale. Add TTL purge if volume warrants (not in scope). |
| feedback.db committed to git | Add `artifacts/python-api/data/` to `.gitignore` — contains PII (user emails) |
| DB initialization fails at startup | Lifespan raises immediately; server does not start in degraded state. Clear error in FastAPI logs. |

## Sources & References

- Feature specification: `AGENT_PROMPT_feedback_mechanism.md`
- Related code: `artifacts/frontend/src/components/AppShell.tsx`, `artifacts/python-api/main.py`
- shadcn Dialog docs: already in the component library at `components/ui/dialog.tsx`
