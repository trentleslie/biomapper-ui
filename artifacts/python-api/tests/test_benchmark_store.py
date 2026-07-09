"""Persistence CRUD for benchmark runs + row logs (plan Unit 5)."""
import asyncio
from pathlib import Path

from services.database import Database


def _db(tmp_path: Path) -> Database:
    db = Database()
    db._path = tmp_path / "bench.db"
    return db


def test_run_and_rowlogs_roundtrip(tmp_path):
    async def run():
        db = _db(tmp_path)
        await db.initialize()
        await db.insert_benchmark_run(
            run_id="r1", user_id="u1", dataset_name="gold", total=2, env="production",
            base_url=None, sdk_version="1.2.1", order_asserted=True,
            config={"hints_stripped": True}, vocabularies=["hmdb"],
            input_names=["a", "b"],
        )
        await db.update_benchmark_run(
            "r1", status="complete", corpus_metrics=[{"vocabulary": "hmdb", "n": 2}]
        )
        await db.insert_row_logs("r1", [
            {"name": "a", "vocabulary": "hmdb", "ground_truth": "HMDB0000001",
             "returned_ids": "HMDB0000001", "hit_ranks": "0", "category": "EXACT_MATCH"},
            {"name": "b", "vocabulary": "hmdb", "ground_truth": "HMDB0000009",
             "returned_ids": "HMDB0000002", "hit_ranks": "", "category": "NO_OVERLAP"},
        ])
        run_row = await db.get_benchmark_run("r1")
        assert run_row["status"] == "complete"
        assert run_row["order_asserted"] is True
        assert run_row["input_names"] == ["a", "b"]
        assert run_row["corpus_metrics"][0]["n"] == 2

        rows = await db.get_row_logs("r1")
        assert len(rows) == 2
        await db.close()
    asyncio.run(run())


def test_list_excludes_input_names(tmp_path):
    async def run():
        db = _db(tmp_path)
        await db.initialize()
        await db.insert_benchmark_run(
            run_id="r1", user_id="u1", dataset_name="d", total=1, env="production",
            base_url=None, sdk_version="1.2.1", order_asserted=True, config={},
            vocabularies=["hmdb"], input_names=["secret"],
        )
        listed = await db.list_benchmark_runs("u1")
        assert len(listed) == 1
        assert "input_names" not in listed[0]
        # user scoping
        assert await db.list_benchmark_runs("other") == []
        await db.close()
    asyncio.run(run())


def test_rerankable_and_category_filters(tmp_path):
    async def run():
        db = _db(tmp_path)
        await db.initialize()
        await db.insert_benchmark_run(
            run_id="r1", user_id="u1", dataset_name="d", total=3, env="production",
            base_url=None, sdk_version="1.2.1", order_asserted=True, config={},
            vocabularies=["hmdb"], input_names=["a", "b", "c"],
        )
        await db.insert_row_logs("r1", [
            {"name": "a", "vocabulary": "hmdb", "ground_truth": "x", "returned_ids": "x",
             "hit_ranks": "0", "category": "EXACT_MATCH"},        # first_hit 0 -> not rerankable
            {"name": "b", "vocabulary": "hmdb", "ground_truth": "y", "returned_ids": "z;y",
             "hit_ranks": "1", "category": "NORMALIZED_MATCH"},   # first_hit 1 -> rerankable
            {"name": "c", "vocabulary": "hmdb", "ground_truth": "w", "returned_ids": "z",
             "hit_ranks": "", "category": "NO_OVERLAP"},          # no hit
        ])
        rerankable = await db.get_row_logs("r1", rerankable=True)
        assert [r["name"] for r in rerankable] == ["b"]
        no_overlap = await db.get_row_logs("r1", category="NO_OVERLAP")
        assert [r["name"] for r in no_overlap] == ["c"]
        await db.close()
    asyncio.run(run())


def test_recover_and_cascade_delete(tmp_path):
    async def run():
        db = _db(tmp_path)
        await db.initialize()
        await db.insert_benchmark_run(
            run_id="r1", user_id="u1", dataset_name="d", total=1, env="production",
            base_url=None, sdk_version="1.2.1", order_asserted=True, config={},
            vocabularies=["hmdb"], input_names=["a"], status="processing",
        )
        await db.insert_row_logs("r1", [
            {"name": "a", "vocabulary": "hmdb", "ground_truth": "x", "returned_ids": "x",
             "hit_ranks": "0", "category": "EXACT_MATCH"},
        ])
        recovered = await db.recover_stale_benchmark_runs()
        assert recovered == 1
        assert (await db.get_benchmark_run("r1"))["status"] == "interrupted"

        assert await db.delete_benchmark_run("r1") is True
        assert await db.get_benchmark_run("r1") is None
        assert await db.get_row_logs("r1") == []  # cascade
        await db.close()
    asyncio.run(run())
