# Task: Add In-App Feedback Mechanism

## Context

Biomapper UI is used by Phenome Health researchers to annotate biological compound names. Currently there's no way for users to report issues or request features from within the app — they have to go through email or Slack. We need a lightweight, always-available feedback button.

## Goal

Add a floating feedback button that opens a categorized feedback form. Three categories:

1. **Annotation Issue** — "This mapping result seems wrong" (e.g., wrong compound match, missing ID, incorrect confidence score)
2. **Feature Request** — "I wish the app could do X"
3. **UI Error** — "Something looks broken or isn't working"

## Requirements

### Frontend

1. **Floating feedback button**: A small, persistent button (FAB-style or fixed-position) visible on all authenticated pages. Position: bottom-right corner. Use the Phenome Health design system — invoke `/phenome-ui` before making UI changes.

2. **Feedback popup/modal**: Clicking the button opens a modal or popover with:
   - **Category selector**: Three options (Annotation Issue, Feature Request, UI Error) — radio buttons or segmented tabs
   - **Description field**: Textarea for free-form feedback (required, min ~10 chars)
   - **Context auto-capture** (for Annotation Issue category):
     - Current page URL
     - Job ID (if on a dashboard page)
     - Selected compound name (if applicable)
   - **Screenshot attachment** (optional, stretch goal): Allow pasting or uploading a screenshot
   - **Submit button** + success confirmation toast

3. **Category-specific fields**:
   - **Annotation Issue**: Optional "Expected result" text field, auto-attached job ID and compound context
   - **Feature Request**: Just the description
   - **UI Error**: Optional "Steps to reproduce" text field, auto-capture browser info (user agent)

4. **UX details**:
   - Button should not obstruct content — semi-transparent or icon-only until hovered
   - Modal should be dismissible via Escape key and clicking outside
   - Form should clear after successful submission
   - Disable submit while sending, show loading state

### Backend (Python API)

5. **Feedback endpoint**: `POST /feedback` that accepts:
   ```json
   {
     "category": "annotation_issue" | "feature_request" | "ui_error",
     "description": "string",
     "metadata": {
       "page_url": "string",
       "job_id": "string | null",
       "compound_name": "string | null",
       "expected_result": "string | null",
       "steps_to_reproduce": "string | null",
       "user_agent": "string"
     },
     "user_email": "string"
   }
   ```

6. **Storage**: For now, store feedback in a local JSON file or SQLite database at `artifacts/python-api/data/feedback.db`. Each entry gets a UUID and timestamp. We can integrate with GitHub Issues or a ticketing system later.

7. **Notification (optional)**: Send a simple notification when feedback is submitted. Options in order of preference:
   - Log to stdout (simplest — visible in server logs)
   - Write to a file that can be tailed
   - Email notification (if SMTP is configured)

### Current Architecture

- **Frontend**: React/Vite at `artifacts/frontend/src/`
  - `components/AppShell.tsx` — layout shell where the FAB should live
  - `pages/dashboard.tsx` — where annotation context would be captured
  - `components/ui/` — shadcn/ui component library (dialog, button, textarea, etc.)
- **Backend**: FastAPI at `artifacts/python-api/`
  - `routes/` — add new `feedback.py` router
  - `models/schemas.py` — add feedback request model
- **Auth**: Clerk provides user email on the frontend via `useUser()`

### Key Files to Modify

- `artifacts/frontend/src/components/AppShell.tsx` — add floating feedback button
- `artifacts/frontend/src/components/` — new `FeedbackDialog.tsx` component
- `artifacts/python-api/routes/` — new `feedback.py` route file
- `artifacts/python-api/main.py` — register the feedback router
- `artifacts/python-api/models/schemas.py` — feedback request schema

### Design Notes

- Use shadcn/ui `Dialog` or `Sheet` for the modal — it's already in the component library
- The feedback button icon could be `MessageSquarePlus` from lucide-react
- Keep the form simple — the goal is low friction, not comprehensive bug reports
- Auto-populate context silently (don't make the user fill in job IDs manually)
- Consider a simple "Thank you!" toast with confetti-free confirmation after submission
