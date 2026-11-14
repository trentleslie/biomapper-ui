# Harmonization functionality checklist

This file is the pass or fail gate for the harmonization screen competition. A checker walks it top to bottom against each team's running app, in a browser, with no access to the code. One missing line in the gate eliminates the team.

Written against biomapper 1.9.0 and the `/harmonize` routes in `artifacts/python-api/routes/harmonize.py`. Each line has an id, what the user must be able to do or see on screen, and its backing: the route and/or the `report.json` field (`schema_version: 1`) the screen reads. A backing of "screen (team)" means the line is about the screen itself and no route is involved.

Conventions the checker needs:

- Routes are under `/harmonize`. Every route takes the `x-clerk-user-id` header (400 when missing); a run owned by another user is a 404.
- Report fields are written as they appear in `GET /harmonize/runs/{jobId}/report` (snake_case). Run status and items are camelCase.
- A "run" is two-cohort (`POST /harmonize/cohorts`, report `kind` `harmonize_cohorts`), many-cohort (`POST /harmonize/many`, report `kind` `harmonize_many`) or from finished jobs (`POST /harmonize/from-jobs`, report `kind` `harmonize_results`). A from-jobs run is complete as soon as it starts; it has no review items and cannot be resumed or cancelled. Its result sits under `arms.names_only` and `arms.identifier` is null, so the run, items, flags and exports lines read it the same way.
- Inputs are panel metadata only (names and identifier columns). Data rule, stated once and referenced elsewhere: when a recorded run for that kind (two-cohort or many-cohort) is installed, the checker may use the replay backend; until then the checker supplies its own panel-metadata files (2 for two-cohort, 3 to 12 for many-cohort) against a live backend. No recorded run is committed yet (see P-02 and P-03).

## Start a run

| Id | The user can | Backing |
|---|---|---|
| H-01 | Pick two cohort files and start a two-cohort run. The screen then shows the new run as queued or running. | `POST /harmonize/cohorts` (`fileA`, `fileB`, `spec`) |
| H-02 | Pick 2 to 12 cohort files and start a many-cohort run. The screen then shows the new run. | `POST /harmonize/many` (`files`, `spec`) |
| H-03 | Choose the entity type (for example metabolites) from the list the app offers, and optionally type a category override (free text, left blank by default). The chosen entity is shown on the run afterwards. The API offers no category list, so the category control is a plain optional text field passed through as written. | entity types from `GET /discovery/entity-types` (items carry `type`, `aliases`, `defaultPrefixes`, no categories); sent as `spec.entity` and optional `spec.category`; status `entity`; report `entity`, `category` |
| H-04 | For each cohort, set its label. Two cohorts cannot share a label: starting such a run shows "Cohort labels must be distinct (got a, a)." | `spec.a.label`, `spec.b.label`, `spec.cohorts[].label`; 400 from `/cohorts` and `/many` |
| H-05 | For each cohort, pick the name column from a list filled from that file's own header (not typed free, not a fixed list). | `POST /harmonize/inspect` returns `columns` and `rowCount`; `spec.*.nameColumn` |
| H-06 | For each cohort, optionally pick a key column from the same header list. | `inspect`; `spec.*.keyColumn` |
| H-07 | For each cohort, choose which header columns hold each identifier vocabulary (for example HMDB), one or more columns per vocabulary. | `inspect`; `spec.*.vocabularies` (vocabulary name to list of columns) |
| H-08 | See each file's row count and column list right after choosing it, before starting. | `POST /harmonize/inspect` (`rowCount`, `columns`) |
| H-09 | Choosing a column that is not in the file is refused with the message as written, for example "Column 'zzz' is not in file 'a.tsv'. Columns found: name, hmdb." | 400 from `/cohorts` and `/many` |
| H-10 | Start a new many-cohort run with the "remap all" option on, to re-map every row instead of reusing saved mappings. | `spec.remapAll` on `POST /harmonize/many` |
| H-11 | See, on every cohort run, whether name linking is on and the reason, as read-only text. There is no on/off control on cohort runs. | report `name_linking.enabled`, `name_linking.reason` |
| H-60 | Start a from-jobs run by choosing two of the user's own finished mapping jobs of the same entity type, and set each side's label. Only finished jobs can be chosen; two jobs of different entity types are refused with the message as written. The screen then shows the new run as complete. | mapping jobs from `GET /jobs` (`status`), each job's entity type from `GET /jobs/{jobId}` (`config.entity_type`); `POST /harmonize/from-jobs` (`jobA`, `jobB`, `aLabel`, `bLabel`); 400 for different entity types, 409 for an unfinished job |
| H-61 | On a from-jobs run, turn link-by-name on or off before starting (off by default), and see the choice and its reason on the run afterwards. | `POST /harmonize/from-jobs` `linkByName`; report `name_linking.enabled`, `name_linking.decided_by` (`user`), `name_linking.reason` |
| H-62 | Be told, when a chosen job was mapped before harmonizing finished jobs was supported: "This job was mapped before harmonizing finished jobs was supported. Map the file again, then harmonize." | `POST /harmonize/from-jobs` 400 |

How to check H-05 to H-07: use a file whose header has unusual column names; the pickers must offer exactly those names.

How to check H-60 to H-62: map two small panel-metadata files of the same entity type in entity resolution first, and wait for both to finish. H-62 needs a job mapped before this release; a checker without one accepts a team's recorded 400 rendered in the screen.

How to check H-10: the checker only confirms that the option exists and that the run starts. Whether saved mappings are reused is not part of the gate.

## While it runs

| Id | The user can | Backing |
|---|---|---|
| H-12 | See a run's state in words for every state the package can report: queued, running, complete, partial, stalled, paused, expired, cancelled, failed, owned_elsewhere. No state shows as blank or "undefined". A run the package no longer knows reads "unknown" (see H-19). | `GET /harmonize/runs/{jobId}` `state`, `reason`, `stage` |
| H-13 | See progress while running: entities mapped out of total for the run, and the current arm (names_only, identifier, or review). | status `entitiesMapped`, `entitiesTotal`, `progress.arm`, `progress.entitiesDone`, `progress.entitiesTotal` |
| H-14 | On a two-cohort run, see which cohort is being mapped now (per-cohort progress). On a many-cohort run, see the cohorts mapped together with the arm's progress. | status `progress.cohort` (two-cohort), `progress.cohorts` (both) |
| H-15 | Leave the screen while a run is going, come back, and find the run again (listed with its state), still progressing or finished. | `GET /harmonize/runs`, `GET /harmonize/runs/{jobId}` |
| H-16 | Cancel a run that has not finished. The state then reads cancelled. | `POST /harmonize/runs/{jobId}/cancel` |
| H-17 | Resume a cancelled, paused, stalled or expired run. The state then reads queued or running. | `POST /harmonize/runs/{jobId}/resume` |
| H-18 | Never see a server file path anywhere on the screen (status, errors, results). | status carries no `outputDir`, `storeDir` or cohort `path`; paths are scrubbed from bodies |
| H-19 | See a run the package no longer knows listed as "unknown" with its reason, not dropped from the list. | `GET /harmonize/runs` (`state: unknown`, `reason`) |

How to check H-15: start a run, navigate to another page of the app, return to the harmonization screen, and open the run from the list.

How to check H-16 and H-17: the run must still be going. With a recording installed, use the replay with the `BIOMAPPER_HARMONIZE_REPLAY_PACE` setting. Without one, start a live run with enough rows to observe progress (about 30 per cohort, at roughly 4 to 5 seconds per entity).

## Results

Results are available only after the state is complete or partial. Before that, results routes answer 409 with "its report is available once it is complete."; the screen must not show an error page for that, only the run's progress.

| Id | The user can | Backing |
|---|---|---|
| H-20 | See the names-only arm and the identifier arm side by side (links, or groups on many-cohort runs, and unresolved counts for each). | report `arms.names_only`, `arms.identifier`; `summary` |
| H-21 | See how the two arms differ: counts and the sets only the names-only arm found, only the identifier arm found, and both. On many-cohort runs, also the groups whose membership changed. | report `diff.counts`, `diff.names_only_only`, `diff.identifier_only`, `diff.both` (`diff.membership_changed` for many) |
| H-22 | When the identifier arm was skipped, see that it was skipped and the reason, instead of an empty arm. | report `identifier_skipped_reason`; `arms.identifier` is null on two-cohort runs and absent on many-cohort runs |
| H-23 | On two-cohort runs, tell one-to-one links from ambiguous links, and see each link's basis (node, identifier, name_exact, name_casefold) and how many partners each side has. | report `arms.<arm>.links[]` (`one_to_one`, `ambiguous`, `basis`, `a_partners`, `b_partners`) |
| H-24 | See withheld name matches: pairs equal by name only and held back, not linked. | two-cohort: `arms.<arm>.name_match_withheld`; many-cohort: `arms.<arm>.withheld` |
| H-25 | See the unresolved rows of each cohort, including rows that errored, with the row's key and name. | two-cohort: `arms.<arm>.unresolved_rows`, `errored_rows` (per cohort); many-cohort: `arms.<arm>.not_grouped` (per cohort, buckets no_node, unresolved, errored) |
| H-26 | On two-cohort runs, see possible misses: pairs biomapper thinks may be the same entity but did not link. | report `arms.<arm>.possible_missed` |
| H-27 | See the rows excluded from each cohort (blank names) with the reason, and see none-excluded stated plainly when there are none. | report `excluded` (per cohort) |
| H-28 | See the run's warnings as written. | report `warnings` |
| H-29 | See the version pins of the run: biomapper version, API, Kestrel and knowledge graph build. | report `pins`, `biomapper_version`; status `kgBuild`, `kgVerified` |
| H-30 | On many-cohort runs, see the groups, each with its cohorts, its member rows, and whether it is clean, has multiplicity, or is broad. | report `arms.<arm>.groups[]` (`node`, `cohorts`, `clean`, `multiplicity`, `broad`) |
| H-31 | On many-cohort runs, see the run's status (ok, partial, failed) and grade (publishable, or "iteration-grade, not for publication"). | report `status`, `grade` |
| H-32 | On many-cohort runs, see the cross-node review entries (rows linked across different nodes) and the grouped rows whose declared identifiers did not confirm their node. | report `arms.<arm>.cross_node`, `arms.<arm>.id_check_review` |
| H-33 | On two-cohort runs, see the one-sided identifier checks (the review queue). | report `review_queue`, `review` |
| H-34 | Open a review item to see its detail: for a row, the engine's choice, the certificate state and the candidates status with its reason; for a link, both sides with node, node name, identifiers and certificate states, and the question to ask. | `GET /harmonize/runs/{jobId}/review-items`, `GET /harmonize/runs/{jobId}/review-items/{ref}` |

How to check H-22: run a two-cohort set where the cohorts share no identifier vocabulary. The arm shows as skipped with the reason from the report.

How to check H-23: the run must contain both one-to-one and ambiguous links. With a recording installed, the two-cohort recording has both. Without one, supply cohort files with a name that appears twice in one cohort (so it links to two rows) and names that appear once, about 30 rows per cohort, on a live run.

## Review and flags

Flaggable items are of four kinds: link, group, review (the package's review queue, cross-node and identifier-check entries, possible misses, withheld name matches) and unresolved (including errored rows). Each item belongs to one arm (names_only or identifier).

biomapper's suggested flags are: every review entry, every ambiguous link, and every group with multiplicity. Review in biomapper-ui is flag and de-flag only. Accept and reject happen in the expert-review app.

| Id | The user can | Backing |
|---|---|---|
| H-36 | See every item of a run in a list, each with its kind, arm, members and its current flag state, and the total of items and of flagged items. The list lets the user reach every item (paging or scrolling; the route pages at 100 by default, 1000 at most), and the visible total equals the route's `total`. | `GET /harmonize/runs/{jobId}/items` (`total`, `flaggedTotal`, `items[].kind`, `arm`, `flagged`) |
| H-37 | Filter the list by kind, by arm, and by flagged or not flagged. | `GET .../items?kind=&arm=&flagged=` |
| H-38 | See that biomapper's suggestion is already applied on a fresh run: every review entry, every ambiguous link and every group with multiplicity starts flagged. | `items[].suggested`, `items[].flagged` |
| H-39 | See for each item whether its flag state came from biomapper or from the organizer. | `items[].source` (`biomapper` or `organizer`) |
| H-40 | Flag one item and de-flag one item, including one of biomapper's own suggestions. The flagged total changes by one and the item's source reads organizer. | `PUT /harmonize/runs/{jobId}/flags` (`refs`, `flagged`) |
| H-41 | Flag or de-flag in bulk by a filter on kind, arm, basis and ambiguous. The screen shows how many items matched. | `POST /harmonize/runs/{jobId}/flags/bulk` (`filter.kind`, `arm`, `basis`, `ambiguous`; `flagged`) returns `updated` |
| H-42 | Reset all flags, or chosen items, to biomapper's suggestion. Items then read biomapper as their source. | `POST /harmonize/runs/{jobId}/flags/reset` (`refs` optional) |
| H-43 | Close the browser, return later, and find the flags as left (flags are kept on the server per run and per user). | `items` after a reload; flags stored per run and user |

How to check H-40: flag an unflagged link, check the count rises by one, de-flag an ambiguous link that began flagged, check the count falls by one and its source reads organizer; then H-42 returns both.

## Exports

Tables: links, groups, review, unresolved. Each is offered in CSV, TSV and JSON. All carry the flag columns (`flagged`, `flag_source`, `suggested`). A table that does not apply to the run (groups on a two-cohort run, links on a many-cohort run) downloads as a header with no rows.

| Id | The user can | Backing |
|---|---|---|
| H-44 | Download the links table as CSV, TSV and JSON. | `GET /harmonize/runs/{jobId}/export?table=links&format=csv\|tsv\|json` |
| H-45 | Download the groups table as CSV, TSV and JSON. | same route, `table=groups` |
| H-46 | Download the review table as CSV, TSV and JSON. | same route, `table=review` |
| H-47 | Download the unresolved table as CSV, TSV and JSON. | same route, `table=unresolved` |
| H-48 | Download the EITL pairs file as CSV or JSON. TSV is not offered, or is refused with "The EITL pairs file is CSV or JSON: the expert-in-the-loop upload does not read TSV." | same route, `table=eitl_pairs`; `format=tsv` is a 400 |
| H-49 | Have the EITL pairs file hold exactly the flagged links and flagged groups. Flag state changes made on screen show in the next download. | `eitl_pairs` built from the effective flags |
| H-50 | See, next to the EITL pairs download, how many flagged items the file leaves out (flagged review, unresolved and one-row items give no pair). The number is the response header `X-Harmonize-Skipped-One-Sided`. | export response header `X-Harmonize-Skipped-One-Sided` |
| H-51 | Be offered JSON as the default for EITL, with a note that JSON is the exact handoff and CSV cells are formula-neutralized. | screen (team) |
| H-52 | See a visible, disabled "Send to EITL" control beside the exports. | screen (team) |

How to check H-50: flag one review item and one link, download the pairs file, and the screen must say 1 flagged item was left out. The generated API client does not expose response headers, so the screen has to fetch the export in a way that can read them.

How to check H-48 and H-49: open the downloaded file. Columns are `source_text`, `source_id`, `source_dataset`, `target_text`, `target_id`, `target_dataset`, `pair_type`, `resolution_layer`.

## Limits and errors

Limits come from the package. The screen shows the message as written, in the page, not as a generic failure.

| Id | The user can | Backing |
|---|---|---|
| H-53 | Be told when a many-cohort run has fewer than 2 or more than 12 files: "A many-cohort run takes 2 to 12 cohort files (got N)." | `POST /harmonize/many` 400 |
| H-54 | Be told when a file is over 50 MB: "'a.tsv' is larger than the 50 MB limit." The same check shows when picking the file. | `POST /harmonize/inspect` and submit 400 |
| H-55 | Be told when a file has more than 20,000 rows: "a.tsv has 20001 rows; a harmonize job takes at most 20000 rows per cohort file." | submit 400, message from the package |
| H-56 | Be told when 3 runs are already unfinished: "This session already has 3 unfinished harmonize job(s) (limit 3); jobs run one at a time. Wait for one to finish, or cancel_job it." This is HTTP 409. | submit 409, message from the package |
| H-57 | Be told, with the message as written, when a spec and its files disagree (cohort count versus file count) or the spec is not valid. | submit 400 |

How to check H-55 and H-56: these messages come from the package against the live backend. They cannot be produced on the replay backend; the checker runs them once live, or accepts a team's recorded 400 and 409 responses rendered in the screen.

## Navigation

| Id | The user can | Backing |
|---|---|---|
| H-58 | See a navigation entry for harmonization next to entity resolution in the app's left rail, reachable by its accessible name, and open the screen from it. | screen (team) |
| H-59 | Find a visible scroll bar on every list or table of the screen whose content overflows its box (checked by shrinking the window or loading a long list). | screen (team); `docs/harmonization/scroll-audit.md` |

## Verified at review (not checked by the browser walk)

Reviewers check these in the diff, not the checker:

- H-58 is implemented by adding an entry to the exported `NAV_ITEMS` in `artifacts/frontend/src/components/AppShell.tsx`.
- The shell (`AppShell.tsx`), the scroll utilities and `ScrollArea`, and `lib/sankey.ts` are used unchanged from this branch.
- A harmonization screen is not required to show a Sankey. If a team's screen includes one, it must use the shared Sankey component with the user's selected vocabularies.
- Id H-35 is unused (withdrawn); ids were not renumbered.
- P-01 (harmonize two finished mapping jobs) joined the gate as H-60 to H-62.

## Pending owner decision (not part of the gate until resolved)

These are not gate lines. They have no backing yet. They join the gate only when the owner decides and the backing exists.

| Id | Capability | Why pending |
|---|---|---|
| P-02 | Load the built-in example from the screen. | `POST /harmonize/example` exists but answers 400 "The example dataset is not installed." No example data is committed yet. |
| P-03 | Any many-cohort check that needs a recorded many-cohort run on real panel metadata. | The many-cohort routes exist and H-02, H-10 and the many-cohort lines are gate lines, but no many-cohort test data or recording is available yet. Until one is installed, the checker follows the data rule in Conventions: its own 3 to 12 files against a live backend. |
| P-04 | Many-cohort "remap all" having an observable effect. | Each run has its own store, so remap all has no earlier mappings to reuse and its effect cannot be seen. Whether runs should share a per-user store is an owner decision. H-10 stays as "the option exists and the run starts". |

## Gaps found

Lines the brief or the design asked for that no route backs today. They are not in the gate; the owner decides.

| Id | Capability | What is missing |
|---|---|---|
| G-01 | See a review row's candidate alternatives (the engine's other choices), not only its status. | `biomapper.jobs.HarmonizeJobs` has no candidates call; `get_candidates` exists only in the MCP server. The review-item detail (H-34) gives `engineChoice`, `candidatesStatus` and `candidatesReason`, not the candidate list. |
