# Signed-in Home Page Functionality Checklist

This file is the pass or fail gate for the `biomapper-ui` signed-in home page competition. An independent gate tester walks the `HM-*` lines top to bottom against each candidate's running app in a real browser, with no access to the candidate's source code, commits, or report. One failed `HM-*` line (after at most one bounded repair round) eliminates the candidate.

Lines under **Verified at review (`VR-*`)** bind every builder equally and are checked against the diff during Phase 9 review.

## Conventions for the gate tester

- In the shared `dev` base (before a candidate branch is checked out), `/` continues to render `UploadPage` so `dev-link.expertintheloop.io` never displays a placeholder. Each candidate replaces `/` in its own branch.
- Every candidate is run on an isolated local slot (`VITE_DEV_BYPASS_AUTH=true`) managed by `<run_dir>/harness/stack.sh`, backed by deterministic recorded responses with zero calls to the live BioMapper service:
  - Cohort harmonization examples (`POST /api/harmonize/example`) replay recorded fixtures from `artifacts/python-api/data/harmonize_examples/{two_cohort,many_cohort}/recording/`.
  - Single-file mapping demo (`GET /api/map/demo` and `POST /api/map/demo`) runs against the slot's local deterministic BioMapper2 stub (`BIOMAPPER_BASE_URL`).
- **Permitted setup methods (identical for every gate tester):**
  1. **Empty state:** `<run_dir>/harness/stack.sh up <slot> <worktree> --fresh` starts the slot with `0` mapping jobs and `0` harmonization runs.
  2. **Seeded state:** `<run_dir>/harness/seed-home <slot>` inserts 3 deterministic mapping jobs and 2 deterministic harmonization runs owned by `judge-<slot>`. Passing `--many` (`<run_dir>/harness/seed-home <slot> --many`) inserts 25 mapping jobs and 25 harmonization runs to test overflow and scrollbars.
  3. **Fault and latency injection:** Send HTTP `POST` with JSON to the slot's identity proxy at `http://127.0.0.1:<proxy_port>/__test__/faults` with any combination of `{"jobs_500": true, "harmonize_500": true, "example_500": true, "delay_ms": 2500}` to simulate slow responses or HTTP 500 failures on `GET /api/jobs`, `GET /api/harmonize/runs`, and example-launch POSTs (`POST /api/harmonize/example` and `POST /api/map/demo`). Always reset faults with `{"jobs_500": false, "harmonize_500": false, "example_500": false, "delay_ms": 0}` immediately after checking `HM-09` and `HM-13` through `HM-16`.
  4. Do NOT edit files in the candidate worktree or modify SQLite tables directly outside `seed-home`. Record every `seed-home` or `/__test__/faults` call you used.

---

## Browser gate lines (`HM-01` .. `HM-21`)

### Orientation and on-screen copy

| Id | What the user must see or do in the browser | Backing / how to check |
|---|---|---|
| HM-01 | Visiting `/` renders the BioMapper home page inside `AppShell` (`data-testid="app-shell"`), NOT `UploadPage`. `/` has no file-upload control (`input[type=file]`) and renders no mapping or harmonization results table or chart. | `GET /`; inspect snapshot and DOM controls |
| HM-02 | `/` displays a plain-language 1-2 sentence statement of what BioMapper is for, explicitly naming multiple measured biological entity types (for example metabolites, proteins, genes, clinical labs) rather than molecules or metabolomics alone. | Visible heading/lead copy on `/` |
| HM-03 | Visible text on `/` writes the product name as `"BioMapper"` (exact casing), never mentions Replit, contains zero em dashes (Unicode `U+2014`), mentions no funders/grants/awards, spells out `"expert-in-the-loop"` on first use (never bare `"EITL"`), and uses none of the internal terms `"arm"`, `"node"`, `"certificate state"`, or `"multiplicity"`. | Visible text on `/` in empty, seeded, running, and error states |
| HM-04 | Every number shown on `/` comes from live API data (`GET /api/jobs`, `GET /api/harmonize/runs`, or `GET /api/map/demo` when loaded). In empty state with `/api/map/demo` delayed or unavailable, `/` displays no static accuracy, coverage, vocabulary, compound, or cohort-row counts (such as `"~100"` or `"30 rows"`). | Visible text on `/` with `--fresh` and `delay_ms: 2500` |

### One-click hand-offs from `/`

| Id | What the user must see or do in the browser | Backing / how to check |
|---|---|---|
| HM-05 | From `/`, one visible click on the action for mapping a single file (without opening the side rail or guessing menu words) navigates to `/upload`, which renders `UploadPage`. | Click control on `/` -> URL is `/upload` |
| HM-06 | From `/`, one visible click on the action for harmonizing cohorts (without opening the side rail or guessing menu words) navigates to `/harmonize`, which renders `HarmonizePage`'s setup view. | Click control on `/` -> URL is `/harmonize` |
| HM-07 | `/` displays a dedicated visible entry for the single-file mapping built-in example, labelled by what it shows and explicitly described in plain words as a `"built-in sample list (not study data)"` (case-insensitive check for `"built-in sample list"` and `"not study data"`). Clicking it lands inside `AppShell` either on `/demo` (with the sample dataset loaded) or on `/job/<jobId>?demo=true` (with the recorded sample job running or complete). | Visible label on `/`; click -> `/demo` or `/job/:jobId?demo=true` inside `data-testid="app-shell"` |
| HM-08 | `/` displays a dedicated visible entry for the cohort-harmonization built-in example, labelled by what it shows and explicitly described in plain words as `"invented cohort data"` (case-insensitive check for `"invented cohort data"`). Clicking it triggers `POST /api/harmonize/example` and navigates inside `AppShell` to `/harmonize/runs/<jobId>` or `/harmonize/runs/<jobId>/<stage>` with the recorded example run started (not the blank `/harmonize` setup form). | Visible label on `/`; click -> `POST /api/harmonize/example` -> `/harmonize/runs/:jobId(/:stage)?` |
| HM-09 | When `example_500: true` is set on `/__test__/faults` and the user clicks an example-launch button on `/` that posts to `/api/harmonize/example` (and `/api/map/demo` if `/` posts directly rather than linking to `/demo`), `/` displays an error message on screen, re-enables the control, and recovers cleanly once `example_500: false` is restored. | `/__test__/faults` `{"example_500": true}`; click example control on `/` |
| HM-10 | With `seed-home <slot>` loaded, `/` displays recent mapping jobs from `GET /api/jobs` (showing each listed job's `displayName` or short ID and its status), and clicking a listed mapping job navigates in one click to `/job/<jobId>`. | `GET /api/jobs`; click item -> `/job/:jobId` |
| HM-11 | With `seed-home <slot>` loaded, `/` displays recent harmonization runs from `GET /api/harmonize/runs` (showing each listed run's cohort labels and plain-language status without the word `"arm"`), and clicking a listed run navigates in one click to `/harmonize/runs/<jobId>` or `/harmonize/runs/<jobId>/<stage>`. | `GET /api/harmonize/runs`; click item -> `/harmonize/runs/:jobId(/:stage)?` |

### Empty, loading, full-error, and partial-error states

| Id | What the user must see or do in the browser | Backing / how to check |
|---|---|---|
| HM-12 | **Empty state (brand-new user):** After `stack.sh up <slot> <worktree> --fresh` (`0` jobs and `0` runs), `/` renders a clear empty state for recent work with no `"undefined"`, `"null"`, `"NaN"`, or broken layout, and all four start/example actions (`HM-05`..`HM-08`) remain visible and working. | `--fresh`; snapshot `/` |
| HM-13 | **Loading state:** With `{"delay_ms": 2500}` set on `/__test__/faults` and `seed-home <slot>` loaded, reloading `/` shows a visible loading state/skeleton for recent work (not a premature empty state or error) while primary start links stay usable, then populates the items automatically when the delayed responses finish. | `/__test__/faults` `{"delay_ms": 2500}`; reload `/` |
| HM-14 | **Full error state:** With `{"jobs_500": true, "harmonize_500": true}` set on `/__test__/faults`, reloading `/` shows a clear error message and a visible retry button (with primary `/upload` and `/harmonize` doors still usable). Resetting faults to `false` and clicking retry loads and displays the seeded work without a browser refresh. | `/__test__/faults` `{"jobs_500": true, "harmonize_500": true}`; click retry |
| HM-15 | **Partial failure (`jobs` 500, `harmonize` 200):** With `{"jobs_500": true, "harmonize_500": false}` and `seed-home <slot>`, reloading `/` keeps the healthy harmonization runs visible and clickable (`HM-11`), displays an error and retry button for the failed mapping-jobs list, and loads the mapping jobs when `jobs_500` is cleared and retry is clicked. | `/__test__/faults` `{"jobs_500": true, "harmonize_500": false}` |
| HM-16 | **Partial failure (`harmonize` 500, `jobs` 200):** With `{"jobs_500": false, "harmonize_500": true}` and `seed-home <slot>`, reloading `/` keeps the healthy mapping jobs visible and clickable (`HM-10`), displays an error and retry button for the failed harmonization-runs list, and loads the harmonization runs when `harmonize_500` is cleared and retry is clicked. | `/__test__/faults` `{"jobs_500": false, "harmonize_500": true}` |

### Shell round-trips, overflow, and accessibility

| Id | What the user must see or do in the browser | Backing / how to check |
|---|---|---|
| HM-17 | Clicking the Phenome Health mark (`BioMapper home`, `href="/"`) in `AppShell`'s left rail from `/upload`, `/harmonize`, `/demo`, and `/jobs` returns to `/` and renders the home page cleanly. | Rail `BioMapper home` link from each route |
| HM-18 | Clicking `"New job"` in `AppShell`'s left rail opens `/upload` (`UploadPage`). `"New job"` has `aria-current="page"` on `/upload` and does NOT have `aria-current="page"` on `/`. | Inspect `AppShell` nav attributes on `/` vs `/upload` |
| HM-19 | Navigating to `/upload`, `/harmonize`, `/jobs`, `/flagged`, `/benchmark`, and `/demo` confirms each existing page loads inside `AppShell` without console/page errors or visual regressions. | Visit each route on the slot |
| HM-20 | With `seed-home <slot> --many` (25 jobs and 25 runs) at `1280x800`, either `/` caps the recent items shown on `/` and provides working `"View all"` / history links to `/jobs` and `/harmonize`, OR any scrollable recent-work region uses `scroll-visible` so scrollbars are visible and items are not clipped. | `seed-home <slot> --many`; check links or `scroll-visible` |
| HM-21 | Every interactive link and button on `/` can be reached via `Tab` in a sensible order, activates with keyboard (`Enter` or `Space`), and exposes a clear accessible name in `browse snapshot` (no unlabelled icon-only controls or `~` guessed names on primary actions). | `browse snapshot` and `browse press Tab` on `/` |

---

## Verified at review (`VR-01` .. `VR-08`)

Checked from `git diff` and source inspection during Phase 9 winner review; binding on every builder:

| Id | Requirement |
|---|---|
| VR-01 | **Frozen paths respected:** Only `artifacts/frontend/src/pages/home.tsx`, `artifacts/frontend/src/components/home/**`, `artifacts/frontend/src/lib/home*.ts`, `artifacts/frontend/src/**/*.test.ts`, `artifacts/frontend/e2e/home*.spec.ts`, and the `<Route path="/">` lines in `artifacts/frontend/src/App.tsx` are added or modified. |
| VR-02 | **No new dependencies or backend changes:** `package.json`, `pnpm-lock.yaml`, `artifacts/python-api/**`, `artifacts/api-server/**`, and `lib/**` are completely untouched. |
| VR-03 | **Both auth modes wired:** Both `Router` (`<ProtectedRoute component={HomePage} />`) and `DevBypassApp` (`<Route path="/">{() => <HomePage />}</Route>`) in `App.tsx` mount `HomePage` at `/`, while `/upload` mounts `UploadPage` in both. |
| VR-04 | **Brand and provenance hygiene:** Product name is written `"BioMapper"` everywhere in modified files; zero mentions of `"Replit"` / `"replit"` and zero lines retained from the old starter `home.tsx` or `replit.md`. |
| VR-05 | **No em dashes:** Zero `U+2014` characters in `home.tsx`, `components/home/**`, or `lib/home*.ts`. |
| VR-06 | **Live numbers only:** Zero hardcoded accuracy, benchmark, vocabulary, compound, or cohort-row numbers in `/` source; any count rendered on `/` reads live response fields and omits numbers cleanly when undefined/loading. |
| VR-07 | **No funder/award strings:** Zero mentions of funders, grants, prime/subaward organizations, or award identifiers. |
| VR-08 | **Terminology rules:** `"expert-in-the-loop"` spelled out before any abbreviation (no standalone `"EITL"`), and internal terms (`arm`, including calls to `armLabel()`, `node`, `certificate state`, `multiplicity`) are never rendered on `/`. |
