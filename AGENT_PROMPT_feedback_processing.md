# Task: Feedback Processing & Triage Workflows

## Context

Biomapper UI has an in-app feedback mechanism (see `AGENT_PROMPT_feedback_mechanism.md` and `docs/plans/2026-05-17-001-feat-in-app-feedback-mechanism-plan.md`) that captures structured feedback into a SQLite database at `artifacts/python-api/data/feedback.db`. A `GET /feedback?category=` endpoint exists for category-filtered retrieval.

Three feedback categories exist, each needing a different downstream processing path:

1. **Feature Requests** (`feature_request`) — should become GitHub Issues for tracking and prioritization
2. **UI Errors** (`ui_error`) — should become GitHub Issues for bug triage
3. **Annotation Issues** (`annotation_issue`) — domain-specific corrections that need expert review by researchers, not standard bug triage

Currently there is **no consumption path** — feedback is collected but not acted on. This task creates the processing workflows.

## Goal

Build category-aware feedback processing that routes each type to the right system:

- **Feature requests + UI errors** → GitHub Issues (automated)
- **Annotation issues** → Google Sheets (for researcher review) or alternative structured export

## Requirements

### GitHub Issues Integration (feature_request + ui_error)

1. **Automated issue creation**: Script or GitHub Action that queries `GET /feedback?category=feature_request` and `GET /feedback?category=ui_error`, then creates GitHub Issues for new entries.

2. **Issue formatting**:
   - Title derived from first ~80 chars of description
   - Body includes: full description, category label, user email, submission timestamp
   - For `ui_error`: include steps to reproduce and user agent from metadata
   - Labels: `feedback:feature-request` or `feedback:ui-error`

3. **Deduplication**: Track which feedback IDs have already been synced (either via a `synced_at` column in SQLite or a separate tracking table) to avoid creating duplicate issues on re-runs.

4. **Trigger options** (in order of preference):
   - Manual CLI script (`python scripts/sync_feedback.py`) for on-demand runs
   - Cron-scheduled GitHub Action (e.g., daily)
   - Webhook on feedback submission (most complex, defer if needed)

### Annotation Issue Processing

5. **Export mechanism**: Annotation issues need a different path because they require domain expertise to evaluate (e.g., "this compound mapping is wrong" needs a researcher, not a developer).

   Options to evaluate:
   - **Google Sheets sync**: Push annotation issues to a shared Google Sheet where researchers can review, add notes, and mark as resolved. Use Google Sheets API or Apps Script.
   - **CSV/TSV export**: Simple `GET /feedback?category=annotation_issue` → downloadable file. Lower maintenance but no collaboration features.
   - **Weekly digest email**: Summarize new annotation issues and email to a distribution list.

6. **Annotation issue schema enrichment** (consider for this or a follow-up):
   - Should annotation issues reference specific mapping result IDs to be actionable?
   - Should there be a `status` field (open/acknowledged/resolved) to track triage state?

### Feedback Status Tracking

7. **Status field**: Add a `status` column to the feedback table: `new` | `synced` | `acknowledged` | `resolved`. Default: `new`. Updated by the sync scripts.

8. **GET endpoint enhancement**: Support `?status=new` filter so sync scripts can query only unprocessed entries.

## Current Architecture

- **Feedback storage**: SQLite at `artifacts/python-api/data/feedback.db`
- **Retrieval endpoint**: `GET /feedback?category=<cat>` returns JSON array, most recent first
- **Feedback schema**: `{ id, category, description, metadata: { page_url, job_id, user_agent, expected_result, steps_to_reproduce }, user_email, created_at }`
- **Backend**: FastAPI at `artifacts/python-api/`
- **Target repo for GitHub Issues**: This repo (`biomapper-ui` or equivalent)

## Key Files

- `artifacts/python-api/services/feedback_store.py` — FeedbackStore service (add status column, migration)
- `artifacts/python-api/routes/feedback.py` — enhance GET endpoint with status filter
- `artifacts/python-api/models/feedback.py` — add status to schema
- Create: `artifacts/python-api/scripts/sync_feedback_to_github.py` — GitHub sync script
- Create: `artifacts/python-api/scripts/export_annotation_issues.py` — annotation export script (or Google Sheets sync)

## Open Questions

- **Who reviews annotation issues?** Need to identify the researcher(s) responsible for evaluating mapping quality corrections.
- **Google Sheets vs CSV export?** Depends on whether collaborative review (comments, status tracking in-sheet) is needed or if a simple export suffices.
- **How often should sync run?** Daily cron is likely sufficient given expected low volume. Could be manual-only initially.
- **Should the feedback form show a "tracking ID" to users?** So they can reference their submission later (e.g., "I submitted feedback #abc-123 last week").

## Design Notes

- Keep the sync scripts simple and idempotent — safe to re-run without side effects
- Use the `gh` CLI or PyGithub for GitHub Issue creation
- The Google Sheets API requires a service account — document the credential setup
- Consider a simple `--dry-run` flag on sync scripts to preview what would be created
- The status tracking migration should be backwards-compatible (default `new` for existing rows)
