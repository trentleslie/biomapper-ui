# Harmonization Screen Competition (Stages 1 to 3, PR 2) Plan

**Goal:** Three agent teams each build a working harmonization screen for biomapper-ui on the merged shared base. A functionality gate, then ease-of-use judging, picks one. Only the winner opens a PR to `dev`.

**Spec:** `docs/brainstorms/2026-11-13-harmonization-competition-design.md` on `dev` (section 6, stages 1 to 3). **Gate:** `docs/harmonization/functionality-checklist.md` on `dev` (61 gate lines H-01 to H-64, H-35 withdrawn, minus none; P-04 pending; G-01 gap).

**Base:** `origin/dev` at `d6f3846`. **Run folder (all outputs persist here by default):** `<run folder>/`

## Budget and stop rules

- **Cap: 30 million subagent tokens for this plan** (the design approved 40 million overall; PR 1 used about 10 million). Tracked from each dispatch's usage line in `ledger.md`. At 30 million the run stops and reports, whatever stage it is in.
- Expected: harness about 2M, three team builds about 5M each, gate about 2M, repair round about 3M, personas about 3M, judging about 1M, winner review and PR about 3M. Total about 29M. These are estimates.
- Stop and report if: all three teams fail the gate after the repair round; the cap is hit; Greptile returns the same comments two rounds running; the merge hook asks for approval.

## Global constraints (every team)

- Work only in your own git worktree and branch. Never read another team's worktree, branch or outputs. Never push. No PR.
- **Backend is frozen.** No changes under `artifacts/python-api`, `artifacts/api-server`, `lib/api-spec`, or generated clients. If the screen needs something the API does not give, report it as a gap; the controller decides and, if accepted, applies it to all three teams equally.
- Use the shared shell, scroll utilities, `ScrollArea` and `lib/sankey.ts` unchanged. Add exactly one entry to `NAV_ITEMS` and the routes for your page in both the signed-in router and the dev-only bypass router in `App.tsx`.
- A visible, disabled "Send to EITL" control beside the exports, with a short note that it is coming.
- Satisfy every gate line in the checklist. Cover two-cohort, many-cohort and finished-jobs runs in one coherent flow.
- Exports that need response headers (`Content-Disposition`, `X-Harmonize-Skipped-One-Sided`) use a raw fetch, since the generated client hides headers. JSON is the default offered for the EITL pairs file.
- Progress shows the current arm and that arm's done out of total; never the job-wide counters as a fraction.
- User-facing copy: no em dashes. Phenome Health design tokens already in `index.css`; read `~/.claude/commands/phenome-ui.md`.
- Tests: unit tests for non-trivial logic, and a Playwright spec that walks your own flow against stubbed API responses (pattern: `e2e/helpers.ts`). Typecheck, unit and e2e green before you report.

## Stage A: judging harness (built once, outside the repo)

Lives in `<run>/harness/`, never committed to biomapper-ui. One builder.

1. **Stack runner** `stack.sh up <slot> <frontend-worktree>` / `down <slot>` / `status`. For slot 1 to 3 it starts: the Python API from ONE reference checkout of `origin/dev` (backend is frozen, so all slots share the code) on its own port with its own `BIOMAPPER_HARMONIZE_HOME` and `BIOMAPPER_DB_PATH` under `<run>/harness/slot-<n>/`, replay backend by default (`BIOMAPPER_HARMONIZE_REPLAY_DIR` at the committed examples, `BIOMAPPER_HARMONIZE_REPLAY_PACE` settable), real backend with `--live`; a tiny identity proxy that forwards `/api/*` to that Python API with `x-clerk-user-id: judge-<slot>` (stands in for Express plus Clerk, which cannot run locally without credentials); and the Vite dev server from the given worktree with the dev-only auth bypass, `API_PROXY_TARGET` pointing at the identity proxy, a dummy Clerk publishable key built at runtime. Prints the URL. Idempotent, logs to `<run>/harness/slot-<n>/logs/`.
2. **Browser driver** `browse` : a CLI over one persistent Chromium (Playwright) per session id: `open <session> <url>`, `snapshot` (accessibility tree with stable refs, plus visible text), `click <ref|text>`, `fill <ref> <text>`, `select`, `upload <ref> <file...>`, `press`, `wait <ms|text>`, `screenshot <name>`, `downloads` (list files the page saved), `close`. Every command is appended to `<session>/actions.jsonl` with timestamp, command, target, result (ok or error text), URL before and after. The pointer is parked off the left rail after each navigation.
3. **Metrics** `metrics <session>`: from `actions.jsonl` computes steps (commands that act), errors (commands that failed, plus error toasts or alerts seen in snapshots), backtracks (navigation back to an already visited URL or reopening a closed dialog or tab), time with no visible progress (longest gap during which consecutive snapshots are identical while a run is not finished), wall-clock, and whether a named goal file was produced. Deterministic; unit-tested on a hand-written log.
4. Proof: bring up a slot on the reference `dev` checkout (no harmonization page exists there), drive the existing upload page with `browse`, load the two-cohort example through the API with curl via the identity proxy and watch it replay, tear down, confirm ports free.

Done when the proof passes and `README.md` in the harness folder documents every command.

## Stage B: three teams build (parallel, one builder each)

Worktrees `<worktrees>/biomapper-ui-harm-team-<name>` on branches `team/<name>` from `origin/dev`.

| Team | Slot | Brief |
|---|---|---|
| gates | 1 | A staged flow in the manner of ddharmon-ui: set up cohorts, run, review and flag, export, one stage at a time, with a rail or stepper showing where you are. |
| single | 2 | One page in the manner of today's entity-resolution upload and dashboard: setup at the top, results below, nothing hidden behind stages. |
| workbench | 3 | Results first: the item table is the page; setup, run status, review detail and exports live in panels around it. |

Each builder gets: the global constraints, its brief, the checklist, the design's persona list (so it knows who will use it, not how it will be scored), and the harness README so it can run its own screen on its slot with the replay backend. It reports the commit, test summaries, any API gaps, and a one-paragraph description of its flow.

Done when: typecheck, unit and e2e are green and the builder has walked its own screen on its slot for a two-cohort example run, a many-cohort example run and a finished-jobs run.

## Stage C: functionality gate

One checker per team, fresh, with no access to the team's code or report: only the slot URL, the checklist, the harness README and the example files. It walks every gate line with `browse` and writes `<run>/gate/<team>/result.json`: per line `pass`, `fail` (with what was looked for, what was seen, a screenshot) or `not-checkable-here` (with why). Lines that need a live backend (limit messages H-55 and H-56) follow the checklist's own rule. "Verified at review" items are not the checker's job.

**Repair round (one, bounded):** a team with failed lines gets exactly those findings back and one attempt to fix them; the checker re-walks only the failed lines plus a 10-line random sample of passed ones (regression check). This is a change from the design's "any miss eliminates": without it a single trivial miss per team would end the run with nothing. After the repair round the design's rule applies: any failed line eliminates the team.

Outcomes: none pass, stop and report; one passes, it wins without ranking; two or three pass, go to Stage D.

## Stage D: ease-of-use ranking

**Personas** (invented for this run, not from user data). Each is a fresh agent that gets only: who they are, their goal in one sentence, their files, the URL, and the `browse` commands. No checklist, no code, no knowledge of other screens. Replay backend with pace 2 seconds so waiting is real but bounded.

| Persona | Files | Goal |
|---|---|---|
| First-timer (a bench scientist, never used the tool) | the two example cohort files | "Find out which analytes in my two files are the same thing, and save the list." |
| Bioinformatician | the five example cohort files | "Harmonize all five cohorts, mark the ambiguous groups for expert review, remove one of the tool's own suggestions you disagree with, and get the file to send to the expert-review team." |
| Presenter | none (uses the built-in example) | "In front of an audience, run the built-in two-cohort example and explain what the results mean." Writes the explanation it would give. |

Each persona runs each surviving screen once: 3 personas x up to 3 screens = up to 9 sessions, each with a 25-minute and 150-command limit. Order of screens is rotated across personas. After each session the persona writes a short first-person account: what was confusing, what it expected and did not find, whether it reached the goal.

**Counted measures** from `metrics`, per session.

**Pairwise judging:** for each persona and each pair of screens, a judge reads both sessions (actions log, the persona's account, key screenshots) with team names removed and screens labelled X and Y, and answers which was easier for that persona, or tie. Each pair is judged twice with X and Y swapped, by a Claude judge and by a Gemini judge (through the Gemini MCP tools if available in this session; if no Gemini access exists, a second Claude judge on a different model tier, and the report says the cross-family check did not happen). A pair whose swapped judgments disagree counts as a draw for that judge.

**Winner rule:** most pairwise wins across personas and judges. Ties broken by lower total backtracks plus errors, then fewer steps. A session that did not reach its goal counts as a loss in every pair for that persona.

## Stage E: comparison page, PR 2, merge

1. **Comparison page** for Trent in `<run>/report/` and published as a private artifact: per team a flow description and screenshots, gate results, per persona measures, pairwise outcomes with judge reasoning, the winner and why, the strongest objections to the winner, and what the losers did better. States plainly that the personas are synthetic and that real people check the screen on dev before production.
2. **Winner's branch:** rebase on current `dev`; add this plan and the run's `ledger.md` summary under `docs/harmonization/competition/`; local code review by a fresh reviewer and one fix wave; full suites green.
3. **PR to `dev`**, Greptile loop with no cap on rounds (stop on two identical rounds), merge at 5/5 with green checks through the policy gate with one plain `gh pr merge`. Confirm the dev deploy and that the harmonization entry appears in the rail on dev.
4. Losing branches are pushed to origin as `competition/<team>` (no PR) and kept until production deploy. Local worktrees stay.
5. Final report: what merged, the counted results, every ruling made, total tokens against the cap, and what to extract into a reusable skill.

## Not in this plan

"Send to EITL" (project 2), production deploy, the reusable skill, the per-user shared store (P-04), a candidates route (G-01).
