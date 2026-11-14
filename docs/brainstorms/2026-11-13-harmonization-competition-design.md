# Harmonization in biomapper-ui, built by a three-team competition

Date: 2026-11-13
Status: design, awaiting Trent's approval
Repo: `trentleslie/biomapper-ui`, base branch `dev` (this doc was written against `origin/dev` at `0e40153`)

Labels used below: **[Trent]** is something Trent decided in conversation. **[Call]** is a choice
made while writing this doc that he has not explicitly confirmed.

## 1. Intent and why

biomapper-ui today resolves the entities in one uploaded file. The biomapper Python package can
also harmonize cohorts (decide which rows in two or more datasets are the same entity), but the
UI exposes none of it and pins a package version that predates it.

The person at the screen is the same researcher who uses entity resolution today. They arrive
with one or more datasets to harmonize. They leave with a reduced list of links or matches that
is ready for expert review in expert-in-the-loop (EITL). **[Trent]**

Nobody knows the best screen layout for this, so instead of picking one design, three agent
teams each build a different one and a scoring rule picks the survivor ("Level 9: Simulation"
from the Every article Trent supplied). This run is a one-off for this project. A reusable skill
is extracted afterwards from what worked. **[Trent]**

## 2. Goals, non-goals, anti-goals

### Goals

1. Two-cohort and many-cohort harmonization in biomapper-ui, covering the full functionality of
   the biomapper package's harmonization surface. **[Trent]**
2. Ease of use, for the researcher described above. **[Trent]**
3. ddharmon-ui's Phenome Health branding and app shell applied to biomapper-ui. **[Trent]**
4. Results downloadable as CSV, TSV and JSON. **[Trent]**
5. Scroll bars on every UI component whose content can overflow. **[Trent]**
6. The Sankey chart reflects the vocabularies the user selected for output. **[Trent]**
7. The winning build merges to `dev` with no human approval once Greptile gives 5/5. **[Trent]**

### Non-goals

- Automatic EITL campaign creation. That is project 2 (section 9). **[Trent]**
- A reusable competition skill. Extracted after this run. **[Trent]**
- Production deploy. Stays with Trent. **[Trent]**
- Changes to the biomapper package or the biomapper2 engine. If a team finds a package bug, it
  is reported, not patched here. **[Call]**

### Things that must not happen

- The screen covers only part of the package (for example two-cohort only).
- Greptile is used to pick the winner. The order is fixed: the winner is chosen first, by the
  local scoring in stage 2 (functionality gate, then ease of use). Only after that does the
  winner open a PR, and Greptile reviews that one PR until it reaches 5/5. Greptile judges
  whether the code is sound, never which design is best. **[Trent]**
- A losing team opens a PR. **[Trent]**
- The run waits on Trent for a merge click.
- Results are lost because nobody saved them. Every stage writes its outputs to a timestamped
  run folder by default (Trent's standing artifact rule).

## 3. Current state (verified 2026-11-13)

**biomapper-ui**
- pnpm monorepo: `artifacts/frontend` (React/Vite), `artifacts/api-server` (Express),
  `artifacts/python-api` (FastAPI), `artifacts/mockup-sandbox`, shared `lib/`.
- No harmonization code anywhere.
- `artifacts/python-api/requirements.txt` pins `biomapper>=1.5.5`. What production actually has
  installed was not checked; Trent believes it lacks harmonization support. The builder should
  check the deployed version (Trent's `/servers` command has the hosts).
- Sankey: `artifacts/frontend/src/lib/sankey.ts`. `buildSankeyData(summary, results,
  includeVocabLayer)` adds a vocabulary node for every vocabulary present in the results. It
  does not take the user's selected output vocabularies as input, although `dashboard.tsx`
  already knows them ("Vocabularies the user picked on the upload page").
- Background jobs already exist: `artifacts/python-api/services/jobs.py`, `routes/jobs.py`.

**biomapper package** (version 1.9.0, released to PyPI 2026-11-13 to close the gaps this design
found; verified by a fresh install: `biomapper.jobs` imports without the MCP SDK, `on_progress`
is present, reports have `to_dict()`)
- `biomapper.harmonize.harmonize(a_results, b_results, *, a_label, b_label, key, link_by_name)`
  returns `HarmonizationResult`. Local and offline, over already-resolved results. Link bases:
  `node`, `identifier`, `name_exact`, `name_casefold`. Reports one-to-one links, ambiguous links
  (`a_partners` / `b_partners`), withheld name matches, unresolved rows on each side, and
  possible misses.
- `biomapper.harmonize_cohorts(a, b, *, entity, a_name_column, b_name_column, a_vocabularies,
  b_vocabularies, a_key_column, b_key_column, a_label, b_label, category, ...)` returns
  `CohortHarmonizationReport`: a names-only arm and an identifier arm, their diff, a review
  queue, and version pins.
- `biomapper.harmonize_many(cohorts, *, entity, name_columns, vocabularies, key_columns,
  category, store_dir, remap_all, ...)` returns `ManyCohortReport`: node-anchored groups across
  all cohorts, review checks, a group diff between arms, a status and grade, excluded rows,
  warnings, and a persistent store.
- One entity type per run. Name links apply to small molecules only. This is decided by the
  category and cannot be overridden in `harmonize_cohorts` or `harmonize_many`; every report
  carries a `name_linking` block (`enabled`, `reason`). Only the offline `harmonize()` takes an
  explicit `link_by_name`.
- `biomapper.jobs.HarmonizeJobs` runs both functions as resumable background jobs (the same
  runner the MCP server uses). Entered once per process; on entry it re-queues unfinished jobs,
  so a server restart needs no resubmit. Cohorts are TSV/CSV file paths inside declared
  `roots`. One job runs at a time; default cap of 3 unfinished jobs (`harmonize_max_queued`);
  limits of 12 cohorts, 20,000 rows and 50 MB per file. `store_dir` defaults to a folder
  shared between jobs. Status, progress (`HarmonizeProgress`), review items and `load_report`
  are all plain data.
- Every run writes `report.json` (`schema_version: 1`), the single source for exports.
- `MappingResult.confidence_score` changed meaning in 1.9.0: it is now the score of the chosen
  node, and can be lower or blank where it used to borrow another node's score. The old value
  is `max_annotator_score`. Full note: `docs/migration-1.9.0.md` in the package.
- The public mapping API runs at roughly 4 to 5 seconds per entity, so every harmonization run
  is a long background job.

**ddharmon-ui** (`Phenome-Health/ddharmon-ui`)
- FastAPI backend, React/Vite frontend. `frontend/src/components/AppShell.tsx`,
  `frontend/src/index.css`, Inter variable fonts in `frontend/public/fonts`, PH logos in
  `frontend/src/assets/ph`.
- Its review flow is staged "gates" (`components/gate/*`, `pages/run/gate1.tsx`).
- Trent also has a `/phenome-ui` command that loads the Phenome Health design system.

**expert-in-the-loop**
- `POST /api/campaigns/:id/pairs` accepts a CSV or JSON file, or a JSON `pairs` array with
  `source_text`, `source_id`, `source_dataset`, `target_text`, `target_id`, `target_dataset`,
  optional `pair_type` and `resolution_layer`. Pairs are two-sided.
- Requires a signed-in admin. No service token exists.

**Merge path**
- `~/.config/pr-policy/repos.json` sets `trentleslie/*` to `on_5_of_5: auto_merge`, squash.
- `~/.claude/hooks/scripts/github-verify.py` lets a merge through without the approval prompt
  when `pr-policy can-merge` passes: PR open, CI green, Greptile 5/5 on the current head, no
  unresolved Greptile threads. The command must be exactly one plain `gh pr merge <N> --squash`
  (optionally `--repo`, `--match-head-commit`). Force-pushes are still gated.
- Not yet test-fired from inside a background agent.

## 4. Constraints

- All changes go through pull requests to `dev`. Nothing deploys directly.
- Each agent that writes code gets its own git worktree, branched from `origin/dev`. No
  branches in a shared checkout.
- Worktrees are not enough isolation: each team also runs its own backend and frontend on its
  own ports.
- Greptile bills per review. Losing teams never open a PR.
- No real cohort data that is restricted (Arivale, UK Biobank participant data). Test inputs
  are panel metadata only (names and identifier columns), which is all the package needs.
- Size: about 9 agents. A hard token cap is set before dispatch and the run stops at it.
  **[Call]** Proposed cap: 40M tokens. This number is a guess, not a measurement.

## 5. Approaches considered

**A. Mockup tournament, then one build.** Three clickable mockups on canned data, score, build
the winner once. Cheapest. Rejected because canned data hides the friction that matters here:
long-running jobs and many-cohort results at real size.

**B. Shared backend, three real front ends.** Chosen. **[Trent]** Ease of use and full
functionality can only be judged honestly on a running screen with real inputs. Building the
backend once removes most of the triple cost.

**C. Two rounds: four mockups, cut to two, build those two.** More variety, fewer real builds,
but an extra stage and a second scoring pass on a first-ever run.

Approach B was then checked against published practice (web search, 2026-11-13; mostly small
studies and practitioner posts, read as search summaries). Four amendments, all accepted by
Trent:

1. Synthetic users complete tasks that stop real people, so they screen but do not validate.
   Rank on counted behaviour, give personas no knowledge beyond what is on screen, and put the
   real-person check at the `dev` to production step.
2. LLM judges show position bias in pairwise comparisons and favour their own model family.
   Score objective criteria directly, run each pairwise comparison twice with the order
   swapped, and add a judge from a different model family (Gemini is already wired in).
3. Separate ports and backends per team, branching from a clean `origin/dev`.
4. Judges drive a real browser through whole flows (Playwright), not single screenshots.

## 6. The design

### Stage 0: fixed work, built once, not competed

One builder, one worktree, one branch (`feat/harmonization-base`). It goes up as its own PR to
`dev` and merges at Greptile 5/5 before the teams start, so the winner's PR carries only the
screen. One PR holding everything would be too large for a useful review. Merging to `dev`
deploys to the dev server automatically. **[Trent]** Both PRs target `dev` on
`trentleslie/biomapper-ui`, the only place Greptile runs; the org has no Greptile, and no org
repo sync is part of this project. **[Trent]**

1. **Backend.** New FastAPI routes in `artifacts/python-api` built on
   `biomapper.jobs.HarmonizeJobs`, entered in the FastAPI lifespan. Do not wrap the functions
   in the UI's own in-memory job service. Routes cover submit (two-cohort and many-cohort),
   status with progress (`on_progress`), resume, cancel, report, and review items. Runs must
   survive a server restart, because every merge to `dev` restarts the service. **[Call]**
   Give each job its own `store_dir`. Raise the pin to `biomapper>=1.9.0`. A third route
   harmonizes two finished entity-resolution jobs with the offline `harmonize()`, no
   re-mapping, with `link_by_name` as a user option. **[Call]** Regenerate the API spec and client (`lib/api-spec`, `lib/api-zod`,
   `lib/api-client-react`) the way the repo already does.
2. **Exports.** Built from `report.json`, never by re-parsing the run's TSV tables. CSV, TSV and JSON for links, groups, review items and unresolved rows, keeping
   the existing formula-injection guard on delimited exports. Plus one "EITL pairs" export that
   EITL's existing upload accepts unchanged. Many-cohort groups are expanded to two-sided pairs
   for that file. **[Call]** The expansion rule (all pairs in a group, or each member against
   one anchor) is left to the builder, who should prefer the smaller review list, since a
   reduced list is the stated purpose.
3. **Branding and shell.** Port ddharmon-ui's app shell, colours, Inter fonts and PH logos into
   biomapper-ui for every page, not only the new one.
4. **Scroll bars.** Audit every component that can overflow (tables, dropdowns, dialogs, side
   panels, long lists) and give each a visible scroll bar.
5. **Sankey.** `buildSankeyData` takes the user's selected output vocabularies and shows only
   those in the vocabulary layer, falling back to "all present" when none were selected.
6. **Functionality checklist.** A written list, derived from the package's public surface at
   1.8.0, of everything a screen must let the user do or see. At minimum: two-cohort run;
   many-cohort run; entity type and category; per-cohort name, key and identifier-vocabulary
   columns; a read-only indicator of whether name linking is on and why (an on/off control
   exists only in the finished-jobs mode); names-only and identifier arms and their diff; one-to-one
   versus ambiguous links; withheld name matches; unresolved rows per cohort; possible misses;
   review queue and review checks; groups with status and grade; excluded rows and warnings;
   version pins; re-run and remap-all; every export. The builder completes this list from the
   code and it becomes the gate in stage 2.
7. **Flags.** Per-item flag state for a harmonization run, saved on the server per run and
   per user, seeded from the package's review queue and review items, and editable through
   the API (flag, de-flag, bulk by filter, reset to biomapper's suggestion). Each item records
   whether its current state came from biomapper or from the organizer. The "EITL pairs"
   export contains exactly the flagged set, and every other export carries the flag column.
   Flags survive a server restart. The repo already has a per-user name flag feature
   (`routes/flags.py`, `pages/flagged.tsx`); reuse its storage approach where it fits, but
   run-scoped flags are a separate table. **[Call]** The checklist gains: flag and de-flag a
   single item, bulk flag, see which flags are biomapper's and which are the organizer's.
8. **Test inputs.** Two-cohort: the UK Biobank and Arivale panel metadata the package already
   ships, with its replay. Many-cohort: not available yet. No third cohort's licence could be
   confirmed; tracked in `Phenome-Health/biomapper#16`, which Trent is handling. Stage 2 cannot
   score the many-cohort tasks until that set exists. Each input also gets one recorded real
   run. The functionality gate runs live once on small files. Persona sessions use a paced
   replay of the recorded run, so waiting, progress and resume screens are exercised without
   hours of live mapping. **[Call]**
9. **Built-in example.** A sample dataset the user can load from the harmonization screen, in
   the manner of today's demo page. **[Call]**
10. **Confidence score upgrade.** The 1.9.0 pin changes `confidenceTier` and `needsReview`
   counts on the existing entity-resolution screens with no change in resolutions. Treat a
   blank score as "not scored", not "low", and say so in the UI. Follow the package's
   migration note.
11. **Tests in CI.** The repo has only deploy workflows, so Greptile would be the only merge
    gate. Add a workflow that runs the backend and frontend tests on pull requests. **[Call]**

Stage 0 ends when the backend's tests pass and a scripted two-cohort and five-cohort run both
return results through the new routes.

### Stage 1: three teams, three screens

Each team gets its own worktree branched from the stage 0 branch, its own ports, and a
different brief. Teams may not read each other's worktrees.

| Team | Brief |
|------|-------|
| Gates | A staged flow in the manner of ddharmon-ui: set up cohorts, run, review, export, one stage at a time. |
| Single screen | One page in the manner of today's entity-resolution upload and dashboard. |
| Workbench | Results first: the link and group table is the page, with setup and review as panels around it. |

Review in biomapper-ui is writable. **[Trent]** The person organizing the EITL campaign can
flag or de-flag anything biomapper produced (a link, a group, a review item, an unresolved
row) before the campaign is created. biomapper's own review queue is the starting set of
flags; the organizer can remove any of those and add any others. Flags are not verdicts:
deciding whether a flagged link is right remains the experts' job in EITL.

Every team must: satisfy the full checklist; use the stage 0 shell, scroll bars and Sankey
unchanged; cover both two-cohort and many-cohort in one coherent flow; leave a visible,
disabled "Send to EITL" control next to the exports; and add its screen to the app's
navigation beside entity resolution.

A team is done when its own Playwright run of the checklist passes.

### Stage 2: scoring

**Gate (pass or fail).** One checker walks the checklist against each team's running app in a
real browser. Any missing item eliminates the team. If all three fail, the run stops and
reports; nothing is opened. If one passes, it wins without ranking.

**Ranking (ease of use).** Three synthetic researchers, each given only a goal and the input
files, never the code or the brief:

| Persona | Task |
|---------|------|
| First-timer | Harmonize two files and download the links. |
| Bioinformatician | Harmonize five cohorts, flag the ambiguous groups, de-flag one of biomapper's suggestions, export for EITL. |
| Presenter | Run the two-cohort example live and explain the result to an audience. |

These personas are invented for this run, not derived from real user data. **[Call]**

Each persona drives each surviving screen in Playwright. Recorded per run: steps taken,
backtracks, errors hit, time spent with no visible progress, and whether the task finished.
Then pairwise judgments between screens on the recorded sessions, each pair judged twice with
the order swapped, by a Claude judge and a Gemini judge.

**Winner rule.** **[Call]** Most pairwise wins across personas and judges. Ties broken by the
lower total of backtracks plus errors, then by fewer steps. A pair where the swapped-order
judgments disagree counts as a draw.

**Outputs.** A side-by-side comparison page for Trent (scores, session recordings or
screenshots, why the winner won, the strongest objections to it). All raw scores and sessions
saved to the run folder. Losing branches are kept, unmerged, until Trent deploys to
production.

### Stage 3: PR and merge

1. The winner's branch gets a local code review, and its findings are fixed, before any PR
   exists. This is to arrive at Greptile clean, not to choose the winner. **[Call]**
2. The winner's branch then opens one PR against `dev`.
3. The Greptile loop runs with no cap on rounds. **[Trent]** It stops early only when a round
   makes no progress (the same comments return twice), and then reports that out loud and
   leaves the PR open. **[Trent agreed]**
4. At 5/5 with no unresolved threads and green CI, the agent merges with one plain
   `gh pr merge <N> --squash`. No force-pushes at any point.
5. If the merge hook asks for approval anyway, the agent does not work around it. It reports
   and stops.

### Stage 4: after the run (Trent)

Real people try the merged screen on `dev` before production deploy. Then the reusable skill
is extracted from this run.

## 7. Left to the builder

- Route shapes, job storage, and how `harmonize_many`'s persistent store maps onto the server
  (it should be per job, not shared between users).
- Where harmonization run files live on the server and how long they are kept.
- Exact column layout of each export beyond "EITL accepts the pairs file unchanged".
- The pair-expansion rule for many-cohort groups (see stage 0, item 2).
- How the competition is dispatched (one workflow script or staged agents), as long as stage
  boundaries, isolation and the token cap hold.
- Port assignments and how each team's stack is started and stopped.

## 8. Risks

- **Synthetic researchers may pick the wrong screen.** Mitigated by counted measures, a second
  model family, kept losing branches, and the real-person check before production.
- **Three teams converge on similar screens.** The briefs are deliberately different; if two
  screens are near-identical, the comparison page should say so.
- **The token cap is a guess.** Stage 0 is run first and its cost measured before stages 1 and
  2 are dispatched.
- **Merge from a background agent is untested.** Stage 3 says what to do if it prompts.
- **Greptile rounds without a cap cost credits.** Bounded by the no-progress stop.

## 9. Project 2 (separate, later): "Send to EITL"

Adds service-to-service authentication to expert-in-the-loop and enables the button left by
project 1, creating a campaign and uploading the pairs in one step. One sensible design, an
authentication change in a second repo, reviewed as security work. Not competed. Brainstormed
on its own after project 1 merges.
