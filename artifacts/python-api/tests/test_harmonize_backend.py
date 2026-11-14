import asyncio
import json
import time

import pytest
from biomapper.jobs import CohortSpec, HarmonizeStatus, JobError

from services import harmonize_backend
from services.harmonize_backend import get_backend, make_backend, real_backend
from services.harmonize_replay import ReplayBackend
from services.harmonize_storage import save_cohort_file
from tests.harmonize_fixtures import wait_finished

pytestmark = pytest.mark.asyncio


def replay(recordings, **kw):
    return ReplayBackend(recordings, **kw)


def spec(label):
    return CohortSpec(label=label, path=f"/nowhere/{label}.tsv")


def real(tmp_path, *, base_url, kestrel_url):
    base = tmp_path / "harmonize"
    return real_backend(base / "home", [base / "runs"], base_url=base_url, api_key=None,
                        kestrel_url=kestrel_url)


def spec_file(tmp_path, label):
    names = "".join(f"Metabolite {label}{i}\n" for i in range(12))
    path = save_cohort_file(tmp_path / "harmonize" / "runs" / "r1", label, f"{label}.tsv",
                            ("name\n" + names).encode())
    return CohortSpec(label=label, path=str(path))


async def test_replay_runs_to_recorded_finish(recording_dir):
    async with replay(recording_dir) as b:
        st = await b.submit_cohorts(spec("a"), spec("b"), entity="metabolites")
        assert isinstance(st, HarmonizeStatus) and st.state == "queued"
        final = await wait_finished(b, st.job_id)
        assert final.state == "complete"
        assert final.job_id == st.job_id
        assert b.load_report(st.job_id)["kind"] == "harmonize_cohorts"


async def test_replay_many_cohort_picks_many_recording(recording_dir):
    async with replay(recording_dir) as b:
        st = await b.submit_many([spec("a"), spec("b"), spec("c")], entity="metabolites")
        final = await wait_finished(b, st.job_id)
        assert final.kind == "harmonize_many"
        assert b.load_report(st.job_id)["kind"] == "harmonize_many"
        assert [s.job_id for s in await b.list_jobs()] == [st.job_id]


async def test_replay_emits_recorded_progress_then_cancel_and_resume(recording_dir):
    async with replay(recording_dir, seconds_per_update=0.05) as b:
        st = await b.submit_cohorts(spec("a"), spec("b"), entity="metabolites")
        deadline = time.monotonic() + 5
        while (await b.status(st.job_id)).progress is None:
            assert time.monotonic() < deadline
            await asyncio.sleep(0.01)
        running = await b.status(st.job_id)
        assert running.state == "running"
        assert running.progress["function"] == "harmonize_cohorts"
        with pytest.raises(JobError):
            b.load_report(st.job_id)

        cancelled = await b.cancel(st.job_id)
        assert cancelled.state == "cancelled"
        await asyncio.sleep(0.15)
        assert (await b.status(st.job_id)).state == "cancelled"

        resumed = await b.resume(st.job_id)
        assert resumed.state == "queued"
        final = await wait_finished(b, st.job_id)
        assert final.state == "complete"


async def test_replay_review_items_and_item(recording_dir):
    async with replay(recording_dir) as b:
        st = await b.submit_cohorts(spec("a"), spec("b"), entity="metabolites")
        await wait_finished(b, st.job_id)
        page = b.review_items(st.job_id)
        assert page.job_id == st.job_id
        assert page.total == 2 and page.counts == {"row": 1, "link": 1}
        rows = b.review_items(st.job_id, kind="row")
        assert [i.ref for i in rows.items] == ["r-glucose"]
        first = b.review_items(st.job_id, limit=1)
        assert first.next_offset == 1
        detail = b.review_item(st.job_id, "l-lactate")
        assert detail.job_id == st.job_id and detail.link is not None
        with pytest.raises(JobError):
            b.review_item(st.job_id, "nope")
        with pytest.raises(JobError):
            b.review_items(st.job_id, limit=51)


async def test_replay_unknown_job_raises(recording_dir):
    async with replay(recording_dir) as b:
        with pytest.raises(JobError):
            await b.status("missing")


async def test_replay_copies_report_into_output_dir(recording_dir, tmp_path):
    out = tmp_path / "out"
    async with replay(recording_dir) as b:
        st = await b.submit_cohorts(spec("a"), spec("b"), entity="metabolites", output_dir=out)
        final = await wait_finished(b, st.job_id)
        assert final.output_dir == str(out)
        assert json.loads((out / "report.json").read_text())["kind"] == "harmonize_cohorts"


async def test_make_backend_uses_replay_when_env_set(recording_dir, monkeypatch):
    monkeypatch.setenv("BIOMAPPER_HARMONIZE_REPLAY_DIR", str(recording_dir))
    with pytest.raises(RuntimeError):
        get_backend()
    async with make_backend() as b:
        assert isinstance(b, ReplayBackend)
        assert get_backend() is b
    with pytest.raises(RuntimeError):
        get_backend()


async def test_make_backend_real_uses_mapper_url_and_key(tmp_path, monkeypatch):
    seen = {}

    class FakeJobs:
        def __init__(self, home, roots, **kw):
            seen.update(home=home, roots=roots, **kw)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return None

    monkeypatch.delenv("BIOMAPPER_HARMONIZE_REPLAY_DIR", raising=False)
    monkeypatch.setenv("BIOMAPPER_BASE_URL", "http://mapper.example/api/v1")
    monkeypatch.setenv("BIOMAPPER_API_KEY", "k-123")
    monkeypatch.setattr(harmonize_backend.harmonize_storage, "HARMONIZE_HOME", tmp_path)
    monkeypatch.setattr(harmonize_backend, "HarmonizeJobs", FakeJobs)
    async with make_backend():
        pass
    assert seen["base_url"] == "http://mapper.example/api/v1"
    assert seen["api_key"] == "k-123"
    assert seen["home"] == tmp_path / "home"
    assert seen["roots"] == [tmp_path / "runs"]
    assert (tmp_path / "home").is_dir() and (tmp_path / "runs").is_dir()


async def test_real_backend_requeues_unfinished_job_on_reentry(tmp_path, stub_api):
    # Review Focus 1. stub_api is a local HTTP stub of the mapping API that answers slowly.
    async with real(tmp_path, base_url=stub_api.url, kestrel_url=stub_api.kestrel_url) as b:
        st = await b.submit_cohorts(spec_file(tmp_path, "a"), spec_file(tmp_path, "b"),
                                    entity="metabolites")
        # Leave only once the job has really started mapping, so re-entry has to resume it.
        deadline = time.monotonic() + 30
        while not stub_api.batch_calls:
            assert time.monotonic() < deadline, (await b.status(st.job_id)).model_dump()
            await asyncio.sleep(0.05)
        assert (await b.status(st.job_id)).state in {"queued", "running"}
    calls_before_restart = len(stub_api.batch_calls)
    async with real(tmp_path, base_url=stub_api.url, kestrel_url=stub_api.kestrel_url) as b2:
        ids = [s.job_id for s in await b2.list_jobs()]
        assert st.job_id in ids
        final = await wait_finished(b2, st.job_id, timeout_s=120)
        assert final.state in {"complete", "partial"}, final.model_dump()
        # The second runner did the rest of the mapping: the first one stopped part way.
        assert len(stub_api.batch_calls) > calls_before_restart
        assert b2.load_report(st.job_id)["kind"] == "harmonize_cohorts"
