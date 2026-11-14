# Stage 0 cost: the shared harmonization base

What building the shared base (the plan `2026-11-13-001-feat-harmonization-shared-base-plan`, Tasks 1 to 13) cost. The competition's token cap is set from this.

**These are estimates, not billing figures.** The token count is the controller's tally of the usage lines that subagents reported. It was not read from any billing or usage dashboard.

## Build (Tasks 1 to 12)

| Measure | Value | How it was counted |
|---|---|---|
| Subagent tokens | about 8 million | Sum of the usage lines reported by each subagent dispatch. Resumed agents report cumulative usage, so a resumed agent is counted more than once and the true figure is lower. |
| Subagent dispatches | about 45 | Implementers, fix rounds and reviewers, Tasks 1 to 12. |
| Controller tokens | unknown | The controller's own usage is not included in the figure above. |
| Build tasks | 12 | Tasks 1 to 12 of the plan. |
| Fix rounds | 11 | Review findings sent back to an implementer and fixed. |
| Wall-clock | roughly 5 to 6 hours | Includes waits for owner decisions (Task 5, harmonizing finished mapping jobs; Task 8, the example data). |

Per-task token figures were not kept separately, so this table gives totals only.

## Verification (Task 13, steps 1 to 3 and 5)

Measured in this task, on 2026-11-14 (UTC), against biomapper 1.9.0 and the hosted BioMapper API (`https://biomapper.expertintheloop.io/api/v1`, keyless), at branch commit `b5eeab8`.

| Measure | Value |
|---|---|
| Live two-cohort run, wall-clock | 40 seconds from submit (04:57:13Z) to complete (04:57:54Z), including a forced restart of the Python API (about 4 seconds down) and about 20 seconds of backing off after the hosted API answered 429 Too Many Requests |
| Entities in that run | 53 (the run's own estimate for one arm, 30 + 30 rows); the package counted 107 mappings over both arms, including work redone after the restart |
| Seconds per entity, that run | about 0.4 seconds per counted mapping (40 s / 107), or about 0.75 seconds per estimated entity (40 s / 53) |
| Two 5-name entity-resolution jobs, run one after the other | 4 and 5 seconds each, about 1 second per entity |

The per-entity times above are far below the usual 4 to 5 seconds per entity. The same example names had been mapped against the same hosted API a few hours earlier (the Task 8 recording), and the hosted API answered them quickly. A run on names the API has not seen recently should be planned at 4 to 5 seconds per entity: the two-cohort example would then take roughly 4 to 9 minutes.

Task 13's own subagent tokens are not included above; the controller adds them to its tally.
