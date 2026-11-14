# Harmonization screen competition: results

Run of 2026-11-14 on `dev` at `d6f3846`. Three agent teams each built a harmonization screen on the shared base, in isolated worktrees with the backend frozen. The plan is in `plan.md` beside this file.

## Outcome

The staged four-step screen ("gates": Set up cohorts, Run, Review and flag, Export) won and is the screen in this repository. The other two were a single continuous page ("single") and a results-first table with docked panels ("workbench").

| Screen | Pairwise wins | Draws | Losses | Actions, all personas | Failed commands | Backtracks |
|---|---|---|---|---|---|---|
| gates (winner) | 7 | 4 | 1 | 27 | 1 | 1 |
| workbench | 4 | 2 | 6 | 24 | 0 | 0 |
| single | 2 | 4 | 6 | 22 | 2 | 0 |

## How it was decided

1. **Functionality gate.** A fresh tester per screen walked the checklist (`../functionality-checklist.md`, 63 lines) in a real browser with no access to the code. All three screens passed with no failures: gates 62 passed and 1 could not be produced locally; single 60 and 3; workbench 60 and 3. Lines that could not be produced locally (rare run states, for example) did not count against a screen.
2. **Ease of use.** Three synthetic researchers (a first-time bench scientist, a bioinformatician, a presenter) each used each screen once: nine sessions, each given only a goal, input files and the web address. Every action was logged and counted.
3. **Blind pairwise judging.** Two model families (Claude and Gemini) judged every pair of screens for every persona, twice, with screen letters, listing order and pair order reversed. A pair whose two orders disagreed counted as a draw.

## What the result does and does not show

- The researchers were model-played personas invented for this run, not people, and not derived from user data.
- One session per persona per screen. There is no measure of session-to-session spread.
- Judges read action logs and written accounts, not video or screenshots.
- The result is not robust to the choice of judge family. With Gemini's verdicts alone the winner is first outright (4 wins, 2 draws, 0 losses). With Claude's verdicts alone the winner and the workbench are tied on wins (winner 3 wins, 2 draws, 1 loss; workbench 3 wins, 0 draws, 3 losses), and the tie-break set before judging (fewer backtracks plus failed commands) puts the workbench first, because the workbench had 0 and the winner had 2. An earlier version of this file said the winner was first with either family alone; that was wrong and was corrected on 2026-11-14 after the tally was re-derived with a sensitivity check.
- The combined result (7 wins to 4) holds, and so does the check that counts the two "partly reached" sessions as failures (the winner stays on 7 wins).
- The winner was not the fastest: it took the most actions, and it won none of the presenter comparisons, where the workbench's item drill-downs did better.
- The workbench screen is kept on the `competition/workbench` branch so the two can be compared before anything is promoted to production.
- Runs used a recorded backend and a local stand-in for the sign-in proxy.
- Real people should check the screen on the dev server before it goes to production.

## What was carried into the winner afterwards

From the sessions on the winning screen and from what the other screens did better: a statement that biomapper has already flagged the items an expert should check; export counts that come only from the server, with an explanation of why they need not add up; a preview of the pairs in the expert-review file; plain-language explanations of the two arms and of package terms, checked against the package source; a clearly named "matched pairs" download; several files accepted at once in two-cohort setup (from the single page); readable "A with B" pair lines (from the single page); and a fuller item detail (from the workbench).

## Problems every screen shared that a screen cannot fix

- A link the engine's own review evidence calls contradicted (the example's "Co" and "CO") is not a suggested flag, because review evidence and flaggable items share no key in the API.
- The built-in example is not reachable from the app's home page, which is the entity-resolution screen.
- Flagged review entries have no second side, so they never reach the expert-review pairs file.
