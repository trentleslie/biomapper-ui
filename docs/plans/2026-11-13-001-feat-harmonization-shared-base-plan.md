# Harmonization Shared Base (Stage 0, PR 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship everything about harmonization in biomapper-ui that is not competed: the backend, flags, exports, test inputs, the ddharmon-ui shell, scroll bars, the Sankey fix, the 1.9.0 upgrade and test CI, as one PR to `dev`.

**Architecture:** The FastAPI service owns a `HarmonizeBackend` (the package's `biomapper.jobs.HarmonizeJobs` in production, a `ReplayBackend` over recorded runs in tests and judging) entered once in the app lifespan. Routes are thin: they check ownership in SQLite, call the backend, and shape `report.json` into items, flags and exports. The frontend gets the shell, scroll and Sankey changes but no harmonization screen; the three competing teams build that in the next plan.

**Tech Stack:** Python 3.11, FastAPI, aiosqlite, pytest, biomapper 1.9.0; React 19, Vite, Tailwind 4, wouter, vitest (new), Playwright (new, pre-installed browser); Express proxy; orval codegen; pnpm.

**Spec:** `docs/brainstorms/2026-11-13-harmonization-competition-design.md` (sections 3, 4 and "Stage 0"). Read it before starting. Stages 1 to 3 (the competition) get their own plan after this PR merges and its cost is measured.

## Global Constraints

- Base branch `dev` on `trentleslie/biomapper-ui`. Work in your own git worktree on branch `feat/harmonization-base`, created from the tip of `feat/harmonization-design` (which holds the spec and this plan). Never branch in a shared checkout. Never force-push.
- Pin is exactly `biomapper>=1.9.0`.
- No changes to the biomapper package, biomapper2, or expert-in-the-loop. A package bug is reported, not patched.
- Cohort inputs are panel metadata only (names and identifier columns). No participant data in the repo. The repo is public.
- Every harmonization run's outputs persist on disk by default; nothing is opt-in.
- Exports are built from `report.json` (`schema_version: 1`), never by re-parsing the run's TSV tables.
- Every route takes the `x-clerk-user-id` header the way `routes/flags.py` does (400 when missing). A run owned by another user returns 404.
- User-facing copy and docs: no em dashes.
- No harmonization page and no navigation entry in this PR. Do not add a "Send to EITL" control here.
- Package limits to surface, not reimplement: 12 cohorts, 20,000 rows and 50 MB per file, 3 unfinished jobs. A `JobError` message is written for end users; pass it through.

## Review Focus

1. **Server restart mid-run.** A run that was `running` when the process died is listed and continues after restart, with no resubmit. (Task 3)
2. **Malformed cohort file.** Empty file, missing name column, byte-order mark, wrong delimiter: the user gets a 400 with a readable message and no run row is created. (Task 4)
3. **Another user's run.** Every run-scoped route returns 404 for a run the caller does not own, including export and flags. (Tasks 4, 6, 7)
4. **Spreadsheet formula injection.** A name beginning with `=`, `+`, `-` or `@` is neutralized in CSV and TSV exports. (Task 7)
5. **Queue full.** A fourth unfinished job returns 409 with the package's own message, and the uploaded files for it are removed. (Task 4)

---

## File Structure

```
artifacts/python-api/
  requirements.txt                      modify: pin
  requirements-dev.txt                  create: pytest, pytest-asyncio, httpx
  main.py                               modify: lifespan, router
  services/harmonize_backend.py         create: HarmonizeBackend protocol, real + replay factories
  services/harmonize_replay.py          create: ReplayBackend
  services/harmonize_storage.py         create: per-run directories, upload validation
  services/harmonize_items.py           create: report.json -> flat Item list
  services/harmonize_export.py          create: tables, CSV/TSV/JSON, EITL pairs
  services/harmonize_offline.py         create: finished-jobs mode over harmonize()
  services/database.py                  modify: harmonize_runs, harmonize_flags tables + methods
  services/mapper.py                    modify: needsReview / tier for unscored rows
  routes/harmonize.py                   create: all /harmonize routes
  data/harmonize_examples/              create: two_cohort/ inputs + recorded run
  tests/test_harmonize_*.py             create: one file per service + routes
artifacts/api-server/src/app.ts         modify: proxy /api/harmonize
lib/api-spec/openapi.yaml               modify: harmonize paths + schemas; then codegen
artifacts/frontend/
  package.json, vitest.config.ts        modify/create: vitest
  playwright.config.ts, e2e/            create: scroll + shell smoke
  src/components/AppShell.tsx           modify: ddharmon-ui rail shell
  src/components/ph-logo.tsx            create
  src/assets/ph/, public/fonts/         create: copied from ddharmon-ui
  src/index.css                         modify: self-hosted Inter, chrome tokens, scroll utility
  src/lib/sankey.ts (+ .test.ts)        modify: selectedVocabs
  src/components/SankeyChart.tsx        modify: pass selectedVocabs
  src/pages/dashboard.tsx, demo.tsx     modify: pass selection; "Not scored" label
.github/workflows/test.yml              create
docs/harmonization/functionality-checklist.md   create
```

---

### Task 1: Test CI and frontend test runner

**Files:**
- Create: `.github/workflows/test.yml`, `artifacts/python-api/requirements-dev.txt`, `artifacts/frontend/vitest.config.ts`, `artifacts/frontend/src/lib/utils.test.ts`
- Modify: `artifacts/frontend/package.json` (add `vitest` dev dependency and `"test": "vitest run"`)

**Interfaces:**
- Produces: `pnpm --filter @workspace/frontend test`; `cd artifacts/python-api && pytest`; a workflow named `Tests` that runs both plus `pnpm run typecheck` on every pull request.

- [ ] **Step 1:** Add vitest and a one-assertion test of `cn()` from `src/lib/utils.ts` (`expect(cn("a", false && "b", "c")).toBe("a c")`). Run `pnpm --filter @workspace/frontend test`. Expected: 1 passed.
- [ ] **Step 2:** Write `requirements-dev.txt` (`-r requirements.txt`, `pytest`, `pytest-asyncio`, `httpx`). In a fresh virtualenv install it and run `pytest` in `artifacts/python-api`. Expected: the existing suite passes with the real package imported (the `conftest.py` mock must not activate; assert `biomapper.__version__` is a string in a new `tests/test_package_installed.py`).
- [ ] **Step 3:** Write `test.yml`: trigger `pull_request`; one job `python` (Python 3.11, install dev requirements, `pytest`); one job `frontend` (pnpm install, `pnpm run typecheck`, `pnpm --filter @workspace/frontend test`). Pin actions by commit SHA as `deploy-dev.yml` does.
- [ ] **Step 4:** Commit: `ci: run backend and frontend tests on pull requests`.

### Task 2: biomapper 1.9.0 and the confidence score change

**Files:**
- Modify: `artifacts/python-api/requirements.txt`, `artifacts/python-api/services/mapper.py`, `artifacts/python-api/tests/test_mapper.py`, `artifacts/python-api/models/schemas.py`, `lib/api-spec/openapi.yaml`, `artifacts/frontend/src/pages/dashboard.tsx`, `artifacts/frontend/src/pages/demo.tsx`, `artifacts/frontend/src/lib/result-explainers.ts`

**Interfaces:**
- Produces: each mapping result gains `maxAnnotatorScore: number | null`; `confidenceTier` is `"unknown"` and the row label is "Not scored" when `confidenceScore` is null; `needsReview` no longer treats an unscored resolved row the same as a low one (new field `reviewReason` value `"not_scored"` already has a column; reuse it).

Background: the package's `docs/migration-1.9.0.md`. `confidence_score` is now the score of the chosen node and can be `None` for a resolved row; the old value is `max_annotator_score`.

- [ ] **Step 1: Failing tests** in `test_mapper.py`:

```python
def test_resolved_row_without_score_is_not_scored_not_low():
    row = to_ui_result(make_result(resolved=True, confidence_score=None, max_annotator_score=2.4))
    assert row["confidenceTier"] == "unknown"
    assert row["confidenceScore"] is None
    assert row["maxAnnotatorScore"] == 2.4
    assert row["reviewReason"] == "not_scored"

def test_low_score_still_needs_review():
    row = to_ui_result(make_result(resolved=True, confidence_score=0.4))
    assert row["confidenceTier"] == "low" and row["needsReview"] is True
```

Use whatever the module's existing conversion function and result factory are called; keep the assertions.
- [ ] **Step 2:** Run `pytest tests/test_mapper.py -k "not_scored or still_needs"`. Expected: FAIL.
- [ ] **Step 3:** Change the pin to `biomapper>=1.9.0`, reinstall, implement in `mapper.py`. An unscored resolved row has `needsReview` true with reason `not_scored`, so it stays visible, but is counted separately from low.
- [ ] **Step 4:** Add `maxAnnotatorScore` to the schema and `openapi.yaml`; run `pnpm --filter @workspace/api-spec codegen`; commit generated files (the repo's guard checks them with `git ls-files`).
- [ ] **Step 5:** Frontend: where a tier badge or score renders, show "Not scored" for null, with the tooltip "The annotators did not score the chosen entry. This is not a low score." Add the same sentence to `result-explainers.ts`.
- [ ] **Step 6:** Run `pytest` and `pnpm run typecheck`. Expected: pass. Commit: `feat: upgrade to biomapper 1.9.0 and separate "not scored" from low confidence`.

### Task 3: Harmonize backend, storage and replay

**Files:**
- Create: `services/harmonize_backend.py`, `services/harmonize_replay.py`, `services/harmonize_storage.py`, `tests/test_harmonize_backend.py`, `tests/test_harmonize_storage.py`
- Modify: `main.py`

**Interfaces:**
- Produces:

```python
# harmonize_storage.py
HARMONIZE_HOME: Path   # env BIOMAPPER_HARMONIZE_HOME, default artifacts/python-api/data/harmonize
def runs_root() -> Path                    # HARMONIZE_HOME / "runs"   (the only entry in `roots`)
def jobs_home() -> Path                    # HARMONIZE_HOME / "home"
def new_run_dir() -> tuple[str, Path]      # (upload_id, runs_root()/upload_id) with inputs/ out/ store/
def save_cohort_file(run_dir: Path, label: str, filename: str, data: bytes) -> Path
    # raises CohortFileError(message) for: empty, > 50 MB, not .csv/.tsv/.txt, undecodable
def read_header(path: Path) -> list[str]   # strips a UTF-8 BOM; sniffs comma vs tab
def remove_run_dir(run_dir: Path) -> None

# harmonize_backend.py
class HarmonizeBackend(Protocol):
    async def submit_cohorts(self, a: CohortSpec, b: CohortSpec, *, entity: str, category: str | None = None, output_dir: Path | None = None) -> HarmonizeStatus: ...
    async def submit_many(self, cohorts: list[CohortSpec], *, entity: str, category: str | None = None, output_dir: Path | None = None, store_dir: Path | None = None, remap_all: bool = False) -> HarmonizeStatus: ...
    async def status(self, job_id: str) -> HarmonizeStatus: ...
    async def list_jobs(self) -> list[HarmonizeStatus]: ...
    async def resume(self, job_id: str) -> HarmonizeStatus: ...
    async def cancel(self, job_id: str) -> HarmonizeStatus: ...
    def load_report(self, job_id: str) -> dict: ...
    def review_items(self, job_id: str, *, kind: str | None = None, offset: int = 0, limit: int | None = None): ...
    def review_item(self, job_id: str, ref: str): ...

def make_backend() -> AsyncContextManager[HarmonizeBackend]
    # ReplayBackend when env BIOMAPPER_HARMONIZE_REPLAY_DIR is set, else HarmonizeJobs(
    #   jobs_home(), [runs_root()], base_url=<MapperService base url>, api_key=<same key the mapper uses>)
def get_backend() -> HarmonizeBackend      # the instance entered in lifespan; raises if not started

# harmonize_replay.py
class ReplayBackend:   # satisfies HarmonizeBackend
    def __init__(self, recordings: Path, *, seconds_per_update: float = 0.0): ...
```

`CohortSpec`, `HarmonizeStatus`, `JobError` come from `biomapper.jobs`. `ReplayBackend` reads a recording directory holding `report.json`, `status.json` (a finished `HarmonizeStatus` dump), `progress.jsonl` (one `HarmonizeProgress.to_dict()` per line) and `review_items.json`. `submit_*` returns a `queued` status with a new job id, then replays `progress.jsonl` on a background task at `seconds_per_update` (env `BIOMAPPER_HARMONIZE_REPLAY_PACE`, default 0), ending in the recorded finished status. It picks the recording by kind: `two_cohort/` or `many_cohort/`. `cancel` stops the replay; `resume` restarts it from the last update sent.

- [ ] **Step 1: Failing tests.**

```python
# test_harmonize_storage.py
def test_bom_and_tab_header(tmp_path):
    p = save_cohort_file(tmp_path, "a", "a.tsv", b"\xef\xbb\xbfname\thmdb\nGlucose\tHMDB0000122\n")
    assert read_header(p) == ["name", "hmdb"]

@pytest.mark.parametrize("data,name", [(b"", "a.csv"), (b"x", "a.xlsx"), (b"\xff\xfe\x00", "a.csv")])
def test_bad_files_raise(tmp_path, data, name):
    with pytest.raises(CohortFileError):
        save_cohort_file(tmp_path, "a", name, data)

# test_harmonize_backend.py
async def test_replay_runs_to_recorded_finish(recording_dir):
    async with replay(recording_dir) as b:
        st = await b.submit_cohorts(spec("a"), spec("b"), entity="metabolites")
        final = await wait_finished(b, st.job_id)
        assert final.state == "complete"
        assert b.load_report(st.job_id)["kind"] == "harmonize_cohorts"

async def test_real_backend_requeues_unfinished_job_on_reentry(tmp_path, stub_api):
    # Review Focus 1. stub_api is a local HTTP stub of the mapping API that answers slowly.
    async with real(tmp_path, base_url=stub_api.url) as b:
        st = await b.submit_cohorts(spec_file(tmp_path, "a"), spec_file(tmp_path, "b"), entity="metabolites")
    async with real(tmp_path, base_url=stub_api.url) as b2:
        ids = [s.job_id for s in await b2.list_jobs()]
        assert st.job_id in ids
        assert (await wait_finished(b2, st.job_id)).state in {"complete", "partial"}
```

If stubbing the mapping API over HTTP proves impractical, keep the test and mark it `@pytest.mark.live` (skipped unless `BIOMAPPER_LIVE=1`), and say so in the PR body. Do not delete it.
- [ ] **Step 2:** Run both files. Expected: FAIL (modules missing).
- [ ] **Step 3:** Implement the three modules. In `main.py` lifespan, enter `make_backend()` after `database.initialize()` and exit it before `database.close()`.
- [ ] **Step 4:** Run both files. Expected: PASS. Commit: `feat(harmonize): job backend with restart-safe real runner and replay`.

### Task 4: Run ownership and the harmonize routes

**Files:**
- Create: `routes/harmonize.py`, `tests/test_harmonize_routes.py`
- Modify: `services/database.py`, `main.py` (include router at prefix `/harmonize`), `artifacts/api-server/src/app.ts` (proxy `/api/harmonize` to the Python API the same way `/api/jobs` is proxied, with the same auth middleware and no body-size cap below 110 MB), `lib/api-spec/openapi.yaml`

**Interfaces:**
- Consumes: Task 3.
- Produces table `harmonize_runs(job_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, labels TEXT NOT NULL /* JSON list */, entity TEXT NOT NULL, upload_id TEXT NOT NULL, created_at TEXT NOT NULL)` and `database.insert_harmonize_run(...)`, `get_harmonize_run(job_id) -> dict | None`, `list_harmonize_runs(user_id) -> list[dict]`.
- Produces routes (all under `/harmonize`, JSON camelCase like the rest of the API):

| Method and path | Body | Returns |
|---|---|---|
| `POST /inspect` | multipart `file` | `{columns: string[], rowCount: number}` so a screen can offer column pickers |
| `POST /cohorts` | multipart: `fileA`, `fileB`, `spec` (JSON: `entity`, `category?`, `a` and `b` each `{label, nameColumn, keyColumn?, vocabularies: {VOCAB: [column]}}`) | run status |
| `POST /many` | multipart: `files` (2 to 12), `spec` (JSON: `entity`, `category?`, `remapAll?`, `cohorts: [{label, nameColumn, keyColumn?, vocabularies}]` in file order) | run status |
| `POST /example` | `{kind: "two_cohort"}` | run status, using the files in `data/harmonize_examples/` |
| `GET /runs` | | the caller's runs, newest first, each with status |
| `GET /runs/{id}` | | run status: `status.model_dump(mode="json")` plus `kind`, `labels`, `entity`, `createdAt` |
| `POST /runs/{id}/resume`, `POST /runs/{id}/cancel` | | run status |
| `GET /runs/{id}/report` | | `report.json` as is; 409 `{detail}` until the run is finished |
| `GET /runs/{id}/review-items?kind=&offset=&limit=` | | the package's page, `model_dump(mode="json")` |
| `GET /runs/{id}/review-items/{ref}` | | one item detail |

Each run gets its own `output_dir` (`<run_dir>/out`) and, for many-cohort, its own `store_dir` (`<run_dir>/store`). `JobError` maps to 400, except the unfinished-jobs cap, which maps to 409. On any submit failure the run directory is removed and no row is inserted.

- [ ] **Step 1: Failing tests** against an app whose backend is a `ReplayBackend` (pace 0) via a fixture that sets `BIOMAPPER_HARMONIZE_REPLAY_DIR`:

```python
def test_two_cohort_submit_then_report(client, two_files, spec_two):
    r = client.post("/harmonize/cohorts", files=two_files, data={"spec": json.dumps(spec_two)}, headers=U1)
    assert r.status_code == 200
    job = r.json()["jobId"]
    wait_complete(client, job, U1)
    rep = client.get(f"/harmonize/runs/{job}/report", headers=U1).json()
    assert rep["schema_version"] == 1 and rep["kind"] == "harmonize_cohorts"

def test_other_user_gets_404_everywhere(client, finished_job):          # Review Focus 3
    for path in ["", "/report", "/review-items"]:
        assert client.get(f"/harmonize/runs/{finished_job}{path}", headers=U2).status_code == 404
    assert client.post(f"/harmonize/runs/{finished_job}/cancel", headers=U2).status_code == 404

@pytest.mark.parametrize("bad", [b"", b"\xef\xbb\xbfwrong\tcols\n1\t2\n"])     # Review Focus 2
def test_malformed_file_is_400_and_no_run(client, bad, spec_two):
    r = client.post("/harmonize/cohorts", files=files_with_a(bad), data={"spec": json.dumps(spec_two)}, headers=U1)
    assert r.status_code == 400 and r.json()["detail"]
    assert client.get("/harmonize/runs", headers=U1).json() == []
    assert list(runs_root().iterdir()) == []

def test_queue_full_is_409_and_cleans_up(client_with_cap_backend, two_files, spec_two):   # Review Focus 5
    r = client_with_cap_backend.post("/harmonize/cohorts", files=two_files, data={"spec": json.dumps(spec_two)}, headers=U1)
    assert r.status_code == 409 and "job" in r.json()["detail"].lower()
    assert list(runs_root().iterdir()) == []

def test_many_rejects_one_file_and_thirteen(client, spec_many): ...   # 400 each
def test_missing_user_header_is_400(client): ...
def test_inspect_returns_columns(client): ...                          # ["name", "hmdb"], rowCount 2
```

A name column named in the spec but absent from the file's header is a 400 raised by the route before submit ("Column 'x' is not in file 'a.tsv'. Columns found: ...").
- [ ] **Step 2:** Run the file. Expected: FAIL.
- [ ] **Step 3:** Implement the table, methods, routes and the proxy entry. Add every path and schema to `openapi.yaml`, run codegen, commit generated files.
- [ ] **Step 4:** Run `pytest tests/test_harmonize_routes.py` and `pnpm run typecheck`. Expected: PASS. Commit: `feat(harmonize): run routes with per-user ownership`.

### Task 5: Finished-jobs mode

**Files:**
- Create: `services/harmonize_offline.py`, `tests/test_harmonize_offline.py`
- Modify: `routes/harmonize.py`, `lib/api-spec/openapi.yaml`

**Interfaces:**
- Consumes: `database.get_job(job_id)` (existing mapping jobs, with stored results), Task 4's ownership table.
- Produces:

```python
def to_mapping_result(stored_row: dict) -> MappingResult        # from a stored UI result row
def harmonize_finished_jobs(job_a: dict, job_b: dict, *, a_label: str, b_label: str, link_by_name: bool) -> dict
    # returns HarmonizationResult.to_dict() wrapped as
    # {"schema_version": 1, "kind": "harmonize_results", "labels": [a, b], "name_linking": {"enabled": link_by_name,
    #  "decided_by": "user", "overridable": True, "reason": ...}, "arms": {"names_only": <result>, "identifier": None}}
```

- Route `POST /harmonize/from-jobs` body `{jobA, jobB, aLabel, bLabel, linkByName}`. It runs synchronously (the function is local and offline), writes the dict as `report.json` in a new run directory, inserts a `harmonize_runs` row with `kind = "harmonize_results"`, and returns a finished run status. `GET /runs/{id}` and `/report` serve it from disk without asking the backend.

The wrapper shape puts the single result under `arms.names_only` so Tasks 6 and 7 read all three kinds the same way.

- [ ] **Step 1: Failing tests.**

```python
def test_two_jobs_link_on_shared_identifier():
    rep = harmonize_finished_jobs(job([row("Glucose", {"HMDB": ["HMDB0000122"]})]),
                                  job([row("D-glucose", {"HMDB": ["HMDB0000122"]})]),
                                  a_label="a", b_label="b", link_by_name=False)
    links = rep["arms"]["names_only"]["links"]
    assert len(links) == 1 and links[0]["basis"] in {"node", "identifier"}

def test_name_link_only_when_asked():
    a, b = job([row("Compound X", {})]), job([row("Compound X", {})])
    assert harmonize_finished_jobs(a, b, a_label="a", b_label="b", link_by_name=False)["arms"]["names_only"]["links"] == []
    assert len(harmonize_finished_jobs(a, b, a_label="a", b_label="b", link_by_name=True)["arms"]["names_only"]["links"]) == 1

def test_route_rejects_unfinished_other_users_or_mixed_entity_type_jobs(client): ...   # 409, 404, 400
```

- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. If a stored result row does not hold enough to rebuild a `MappingResult` (the chosen node and identifier sets), stop and report which field is missing instead of approximating; that would need the mapping job to store more, which is a change to raise with Trent.
- [ ] **Step 4:** Run. Expected: PASS. Update `openapi.yaml`, codegen, commit: `feat(harmonize): harmonize two finished mapping jobs offline`.

### Task 6: Items and flags

**Files:**
- Create: `services/harmonize_items.py`, `tests/test_harmonize_items.py`, `tests/test_harmonize_flags.py`
- Modify: `services/database.py`, `routes/harmonize.py`, `lib/api-spec/openapi.yaml`

**Interfaces:**
- Produces:

```python
@dataclass(frozen=True)
class Item:
    ref: str            # stable across reloads: f"{kind}:{arm}:{sha1(sorted member keys)[:16]}"
    kind: str           # "link" | "group" | "review" | "unresolved"
    arm: str            # "names_only" | "identifier"
    suggested: bool     # biomapper's own flag
    members: tuple[dict, ...]   # each {"cohort", "key", "name", "chosenKgId"}
    detail: dict        # basis, ambiguous, one_to_one, multiplicity, status, reason: whatever the report gives

def items_from_report(report: dict) -> list[Item]
```

Where things live in `report.json` (from the 1.9.0 release notes; confirm against a real report and the package's `to_dict()` docstrings):

| Item kind | Two cohorts (`harmonize_cohorts`, `harmonize_results`) | Many cohorts (`harmonize_many`) |
|---|---|---|
| link | `arms.<arm>.links` | none |
| group | none | `arms.<arm>.groups` |
| review | top-level `review_queue` | `arms.<arm>.cross_node`, `arms.<arm>.id_check_review` |
| unresolved | `arms.<arm>.unresolved_rows` | `arms.<arm>.not_grouped` |

`suggested` is true for: every `review` item; a link with `ambiguous: true`; a group with `multiplicity: true`. Everything else starts unflagged. A null identifier arm yields no items and no error.

- Table `harmonize_flags(job_id TEXT, user_id TEXT, item_ref TEXT, flagged INTEGER NOT NULL, PRIMARY KEY (job_id, user_id, item_ref))`. Only organizer overrides are stored; an item with no row has `flagged = suggested`.
- Routes:

| Method and path | Body | Returns |
|---|---|---|
| `GET /runs/{id}/items?kind=&arm=&flagged=&offset=&limit=` | | `{total, flaggedTotal, items: [{ref, kind, arm, members, detail, suggested, flagged, source}]}`, `source` is `"biomapper"` or `"organizer"` |
| `PUT /runs/{id}/flags` | `{refs: string[], flagged: boolean}` | `{updated, flaggedTotal}`; a ref that matches no item is a 400 naming it |
| `POST /runs/{id}/flags/bulk` | `{filter: {kind?, arm?, basis?, ambiguous?}, flagged: boolean}` | `{updated, flaggedTotal}` |
| `POST /runs/{id}/flags/reset` | `{refs?: string[]}` (omitted means all) | `{flaggedTotal}`; deletes override rows |

Setting an item back to its suggested value deletes its row, so `source` returns to `"biomapper"`.

- [ ] **Step 1: Failing tests.** Use the recorded two-cohort `report.json` from Task 8 if it exists; otherwise a hand-built report with one plain link, one ambiguous link, one review item, one unresolved row, and a null identifier arm.

```python
def test_items_cover_every_kind_and_seed_suggestions(report):
    items = items_from_report(report)
    assert {i.kind for i in items} == {"link", "review", "unresolved"}
    assert [i.suggested for i in items if i.detail.get("ambiguous")] == [True]
    assert len({i.ref for i in items}) == len(items)
    assert items_from_report(report) == items                      # refs are stable

def test_deflag_a_suggestion_then_reset(client, finished_job):
    ref = first_item(client, finished_job, suggested=True)["ref"]
    client.put(f"/harmonize/runs/{finished_job}/flags", json={"refs": [ref], "flagged": False}, headers=U1)
    it = get_item(client, finished_job, ref)
    assert (it["flagged"], it["source"]) == (False, "organizer")
    client.post(f"/harmonize/runs/{finished_job}/flags/reset", json={"refs": [ref]}, headers=U1)
    it = get_item(client, finished_job, ref)
    assert (it["flagged"], it["source"]) == (True, "biomapper")

def test_flags_are_per_user_and_survive_restart(app_factory, finished_job): ...
def test_bulk_flag_by_filter_counts(client, finished_job): ...
def test_unknown_ref_is_400(client, finished_job): ...
def test_flag_routes_404_for_other_user(client, finished_job): ...          # Review Focus 3
def test_many_cohort_report_yields_groups(many_report): ...
```

- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Update `openapi.yaml`, codegen.
- [ ] **Step 4:** Run. Expected: PASS. Commit: `feat(harmonize): reviewable items with organizer flags`.

### Task 7: Exports

**Files:**
- Create: `services/harmonize_export.py`, `tests/test_harmonize_export.py`
- Modify: `routes/harmonize.py`, `lib/api-spec/openapi.yaml`

**Interfaces:**
- Consumes: `items_from_report`, effective flags from Task 6.
- Produces:

```python
TABLES = ("links", "groups", "review", "unresolved", "eitl_pairs")
FORMATS = ("csv", "tsv", "json")
def export_rows(report: dict, flags: dict[str, bool], table: str) -> tuple[list[str], list[dict]]
def render(header: list[str], rows: list[dict], fmt: str) -> tuple[bytes, str]     # (body, media type)
def neutralize(cell: str) -> str     # prefix "'" when the cell starts with = + - @ tab or carriage return
```

- Route `GET /runs/{id}/export?table=&format=` returning a file download named `<kind>_<labels joined by _>_<table>.<format>`; unknown table or format is 400; a table that does not apply to the run's kind (for example `groups` on a two-cohort run) returns the header and no rows.
- Every table except `eitl_pairs` has `flagged` and `flag_source` columns and one column group per member (`<label>_key`, `<label>_name`, `<label>_chosen_kg_id`), plus `arm`, `basis` and the detail fields.
- `eitl_pairs` contains only flagged links and flagged groups, in the columns EITL's upload reads: `source_text, source_id, source_dataset, target_text, target_id, target_dataset, pair_type, resolution_layer`. Text is the row's name, id is its key, dataset is the cohort label, `pair_type` is the entity type, `resolution_layer` is the link basis. A flagged group of n members becomes n minus 1 pairs, each member against the first member in label order. Flagged review and unresolved items are one-sided and are not in this file; the route reports their number in a response header `X-Harmonize-Skipped-One-Sided`. `neutralize` applies to CSV and TSV only.

- [ ] **Step 1: Failing tests.**

```python
def test_eitl_pairs_is_exactly_the_flagged_two_sided_set(report):
    header, rows = export_rows(report, flags_for(report, flagged_refs={LINK_REF}), "eitl_pairs")
    assert header == ["source_text","source_id","source_dataset","target_text","target_id","target_dataset","pair_type","resolution_layer"]
    assert len(rows) == 1 and rows[0]["source_dataset"] != rows[0]["target_dataset"]

def test_group_of_four_expands_to_three_pairs(many_report): ...

@pytest.mark.parametrize("name", ["=SUM(A1)", "+1", "-1", "@x"])                   # Review Focus 4
def test_delimited_exports_neutralize_formulas(name, fmt_csv_tsv):
    body, _ = render(["name"], [{"name": name}], fmt_csv_tsv)
    assert body.decode().splitlines()[1].startswith("'")

def test_json_export_is_not_neutralized(): ...
def test_null_identifier_arm_exports_names_only_rows_without_error(report): ...
def test_export_route_404_for_other_user(client, finished_job): ...                # Review Focus 3
def test_eitl_file_is_accepted_by_eitl_parser(): ...
```

For the last test, copy the required-field rule from `expert-in-the-loop/server/routes.ts` (`sourceText`, `sourceId`, `targetText`, `targetId` all non-empty) into the test as the acceptance check, and note the EITL commit it was read at.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Update `openapi.yaml`, codegen.
- [ ] **Step 4:** Run. Expected: PASS. Commit: `feat(harmonize): CSV, TSV, JSON and EITL pairs exports`.

### Task 8: Example inputs and a recorded run

**Files:**
- Create: `artifacts/python-api/data/harmonize_examples/two_cohort/{a.tsv,b.tsv,spec.json,SOURCE.md}`, `.../two_cohort/recording/{report.json,status.json,progress.jsonl,review_items.json,PINS.md}`, `artifacts/python-api/scripts/record_harmonize_run.py`, `tests/test_harmonize_examples.py`

**Interfaces:**
- Produces: the files `POST /harmonize/example` uses, and the recording `ReplayBackend` reads when `BIOMAPPER_HARMONIZE_REPLAY_DIR=artifacts/python-api/data/harmonize_examples` (subdirectory `two_cohort/recording`).

- [ ] **Step 1:** Take the UK Biobank and Arivale metabolite panel metadata that ships inside the biomapper package (find it under the installed package's data or `notebooks/` in the repo at tag `v1.9.0`). Cut each to about 30 rows chosen so the pair produces at least one plain link, one ambiguous link, one review item and one unresolved row on each side. Write `SOURCE.md`: package version, source file paths, the selection rule, and the package's licence statement for those files. If the package's own notes do not clearly allow redistribution, stop and ask Trent.
- [ ] **Step 2:** Write `record_harmonize_run.py`: runs the real backend on a spec, appends every `on_progress` update to `progress.jsonl`, and on finish writes `status.json`, copies `report.json`, dumps all review items, and writes `PINS.md` (biomapper version, the report's `pins` block, date, command). It saves to a timestamped directory by default and prints the path. Run it live once for the two-cohort example (about 5 minutes at 4 to 5 seconds per entity) and commit the result as the recording.
- [ ] **Step 3: Tests:** `test_recording_has_every_item_kind` (items_from_report on the recording yields link, review and unresolved, with at least one ambiguous link); `test_example_route_runs_on_replay`.
- [ ] **Step 4:** Rerun Tasks 6 and 7 tests against the recording in place of the hand-built report. Expected: PASS. Commit: `feat(harmonize): two-cohort example with a recorded run`.

The many-cohort example is not built here. It waits on `Phenome-Health/biomapper#16`. Leave `many_cohort/` absent; `ReplayBackend.submit_many` raises `JobError("No many-cohort recording is installed.")` until it exists.

### Task 9: ddharmon-ui shell and branding

**Files:**
- Create: `artifacts/frontend/src/components/ph-logo.tsx`, `artifacts/frontend/src/assets/ph/*`, `artifacts/frontend/public/fonts/inter-var-*.woff2`, `artifacts/frontend/playwright.config.ts`, `artifacts/frontend/e2e/shell.spec.ts`
- Modify: `artifacts/frontend/src/components/AppShell.tsx`, `DemoShell.tsx`, `src/index.css`, `package.json` (`"e2e": "playwright test"`, dev dependency `@playwright/test` matching the pre-installed version; do not run `playwright install`)

**Interfaces:**
- Produces: `AppShell` with the same props and the same navigation destinations as today, in ddharmon-ui's form; `data-testid="app-shell"` and `data-testid="app-nav"` with `data-expanded`; CSS tokens `--color-surface-chrome`, `--color-on-chrome`, `--color-on-chrome-muted`; an exported `NAV_ITEMS` array in `AppShell.tsx` so the winning team adds one entry.

Source of truth: `Phenome-Health/ddharmon-ui` at the commit you read (record the SHA in the PR body): `frontend/src/components/AppShell.tsx`, `frontend/src/components/ph-logo.tsx`, `frontend/src/index.css`, `frontend/src/assets/ph/`, `frontend/public/fonts/`. Also load Trent's `/phenome-ui` design system reference.

What to port: the left rail that rests as icons and expands on hover or keyboard focus over the content (no layout reflow), no top bar, the PH mark as the home link, the account control and build stamp at the rail's foot, the chrome colour tokens, self-hosted Inter (remove the Google Fonts `@import` for Inter; keep JetBrains Mono as is), and the funding acknowledgement component if biomapper-ui has none. What not to port: ddharmon-ui's pages, gates, status banner text, or anything about its own navigation destinations. biomapper-ui's existing `ph-*` colour tokens stay; add only what the shell needs.

- [ ] **Step 1: Failing Playwright test** `e2e/shell.spec.ts` against the demo route (no sign-in needed): the shell and nav exist; the nav is collapsed at rest (`data-expanded="false"`); hovering it sets `data-expanded="true"` and the main content's bounding box x does not change; every destination that existed before is still reachable by its accessible name; the computed `font-family` of `body` starts with Inter and no request goes to `fonts.googleapis.com` for Inter.
- [ ] **Step 2:** Run `pnpm --filter @workspace/frontend e2e`. Expected: FAIL.
- [ ] **Step 3:** Port. Take a screenshot of the demo page and of the upload page at 1440 by 900 and compare by eye with ddharmon-ui's shell; attach both to the PR.
- [ ] **Step 4:** Run e2e and `pnpm run typecheck`. Expected: PASS. Add the e2e job to `test.yml`. Commit: `feat(ui): adopt the ddharmon-ui shell and Phenome Health branding`.

### Task 10: Scroll bars

**Files:**
- Modify: `artifacts/frontend/src/index.css`, every component found by the audit, `artifacts/frontend/src/components/ui/scroll-area.tsx` if its bar auto-hides
- Create: `artifacts/frontend/e2e/scroll.spec.ts`, `docs/harmonization/scroll-audit.md`

**Interfaces:**
- Produces: a utility class `scroll-visible` (always-drawn, themed scroll bar: `overflow: auto; scrollbar-gutter: stable; scrollbar-width: thin;` plus `::-webkit-scrollbar` rules that never hide the thumb) and the rule that any container with bounded height or width whose content can exceed it uses it.

- [ ] **Step 1:** Audit. Search `src/` for `overflow-`, `max-h-`, `h-[`, `ScrollArea`, and every Radix popover, select, dropdown, dialog, sheet and table wrapper. List each site in `scroll-audit.md` with its file, what overflows, and the fix. Include the entity-type dropdown (commit `9f821f8` fixed its constraint once), the results table on `dashboard.tsx`, the jobs list, the flagged list, dialogs, and the benchmark tables.
- [ ] **Step 2: Failing Playwright test** `scroll.spec.ts`: for each audited site that can be reached on the demo route, fill it past its bound (the demo dataset is long enough for the table; for dropdowns open them), then assert `scrollHeight > clientHeight` implies computed `overflow-y` is `auto` or `scroll` and the element has class `scroll-visible` or is a `ScrollArea` viewport whose scrollbar element is visible.
- [ ] **Step 3:** Run. Expected: FAIL. Apply the fixes. Run. Expected: PASS.
- [ ] **Step 4:** Commit: `fix(ui): visible scroll bars on every overflowing component`.

### Task 11: Sankey reflects the selected vocabularies

**Files:**
- Modify: `artifacts/frontend/src/lib/sankey.ts`, `artifacts/frontend/src/components/SankeyChart.tsx`, `artifacts/frontend/src/pages/dashboard.tsx`, `artifacts/frontend/src/pages/demo.tsx`
- Create: `artifacts/frontend/src/lib/sankey.test.ts`

**Interfaces:**
- Produces: `buildSankeyData(summary, results, includeVocabLayer = false, selectedVocabs?: ReadonlySet<string>)`; `SankeyChart` gains an optional prop `selectedVocabs?: ReadonlySet<string>`. Comparison is case-insensitive on the CURIE prefix. An empty or undefined set keeps today's behaviour (every vocabulary present). A selected vocabulary with no hits is not drawn.

- [ ] **Step 1: Failing tests.**

```ts
const results = [res("high", { HMDB: ["1"], CHEBI: ["2"], KEGG: ["3"] }), res("low", { hmdb: ["4"] })];
it("draws only the selected vocabularies", () => {
  const d = buildSankeyData(summary, results, true, new Set(["hmdb", "chebi"]));
  expect(vocabIds(d).sort()).toEqual(["vocab_CHEBI", "vocab_HMDB"].sort());       // match the module's existing id casing
  expect(d.links.some(l => l.target.toLowerCase() === "vocab_kegg")).toBe(false);
});
it("falls back to all present when nothing is selected", () => {
  expect(vocabIds(buildSankeyData(summary, results, true, new Set())).length).toBe(3);
});
it("merges prefixes that differ only by case", () => { /* HMDB and hmdb are one node with value 2 */ });
it("omits a selected vocabulary that has no hits", () => { /* Set(["hmdb","drugbank"]) -> only HMDB */ });
```

- [ ] **Step 2:** Run `pnpm --filter @workspace/frontend test sankey`. Expected: FAIL.
- [ ] **Step 3:** Implement. In `dashboard.tsx` pass the set it already holds (the comment "Vocabularies the user picked on the upload page"); in `demo.tsx` pass the demo's configured output vocabularies.
- [ ] **Step 4:** Run. Expected: PASS. Commit: `fix(ui): Sankey shows the vocabularies selected for output`.

### Task 12: The functionality checklist

**Files:**
- Create: `docs/harmonization/functionality-checklist.md`

**Interfaces:**
- Produces: the pass or fail gate for the competition. Each line: an id (`H-01` and up), what the user must be able to do or see, and which route or report field backs it. The next plan's checker walks this file.

- [ ] **Step 1:** Write it from the routes built here and the package's public surface at 1.9.0. It must contain at least: start a two-cohort run; start a many-cohort run (2 to 12 files); harmonize two finished mapping jobs, with a link-by-name control; choose entity type and category; choose each cohort's label, name column, key column and identifier-vocabulary columns from the file's own header; see the name-linking indicator and its reason on cohort runs; see per-arm and per-cohort progress while running; leave and return to a running job; resume and cancel; see names-only and identifier arms and their difference, and the reason when the identifier arm was skipped; tell one-to-one from ambiguous links; see withheld name matches, unresolved rows per cohort, possible misses, excluded rows and warnings; see groups with status and grade on many-cohort runs; see the version pins; open a review item's detail and candidates; flag and de-flag one item; bulk flag by filter; see which flags are biomapper's and which are the organizer's; reset to biomapper's suggestion; download each table as CSV, TSV and JSON; download the EITL pairs file and see how many flagged one-sided items it leaves out; re-run with remap-all on many-cohort; load the built-in example; a visible disabled "Send to EITL" control; the screen reachable from the navigation; package limit messages shown as written.
- [ ] **Step 2:** For each line, confirm the backing route exists by calling it against the replay backend. A line with no backing is a gap in this plan: add the route, do not drop the line.
- [ ] **Step 3:** Commit: `docs(harmonize): functionality checklist for the competition gate`.

### Task 13: Verify, review, PR 1, merge

**Files:**
- Create: `docs/harmonization/stage0-cost.md`

- [ ] **Step 1:** Run everything: `pytest` in `artifacts/python-api`; `pnpm run typecheck`; `pnpm --filter @workspace/frontend test`; `pnpm --filter @workspace/frontend e2e`. Expected: all pass. Paste the summary lines into the PR body.
- [ ] **Step 2:** One live end-to-end run through the HTTP routes (real backend, the Task 8 two-cohort inputs): submit, poll to finish, restart the Python service once mid-run and confirm it continues, fetch the report, flag and de-flag, download all five tables. Save the outputs to a timestamped folder and name it in the PR body.
- [ ] **Step 3:** Check what the dev server has installed (Trent's `/servers` command lists the host) and note in the PR body that merging redeploys dev and upgrades it to biomapper 1.9.0, and that the Python service needs write access to `BIOMAPPER_HARMONIZE_HOME`. If `deploy/` needs a directory or environment line for that, add it in this PR.
- [ ] **Step 4:** Local code review of the whole branch by a fresh reviewer; fix what it finds.
- [ ] **Step 5:** Write `stage0-cost.md`: tokens and wall-clock this plan used, per task where known. The competition's token cap is set from this.
- [ ] **Step 6:** Open the PR against `dev` on `trentleslie/biomapper-ui`. Run the Greptile loop with no cap on rounds; stop only if two rounds in a row return the same comments, and then report and leave the PR open. On 5/5 with no unresolved threads and green checks, merge with exactly `gh pr merge <N> --squash --repo trentleslie/biomapper-ui`. If the hook asks for approval anyway, stop and report; do not work around it.
- [ ] **Step 7:** After the merge, confirm the dev deploy workflow succeeded and the dev site loads with the new shell. Report "merged" and "live on dev" as separate facts.

---

## Not in this plan

- The harmonization screen, the three teams, scoring, and PR 2. Planned after this merges.
- The many-cohort example and recording. Waits on `Phenome-Health/biomapper#16`.
- "Send to EITL". Project 2.
- Production deploy. Trent's.
