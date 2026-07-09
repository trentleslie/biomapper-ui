import json
import logging
import os
import time
from pathlib import Path
from typing import Any

import aiosqlite

logger = logging.getLogger("entity-linker")

_DEFAULT_DB_PATH = Path(__file__).resolve().parent.parent / "data" / "biomapper.db"

_CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS jobs (
    job_id       TEXT PRIMARY KEY,
    user_id      TEXT,
    display_name TEXT,
    status       TEXT NOT NULL DEFAULT 'pending',
    total        INTEGER NOT NULL DEFAULT 0,
    completed    INTEGER NOT NULL DEFAULT 0,
    error_count  INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    results      TEXT,
    config       TEXT,
    env          TEXT NOT NULL DEFAULT 'production',
    created_at   REAL NOT NULL,
    updated_at   REAL NOT NULL
)
"""

_CREATE_INDEX = """
CREATE INDEX IF NOT EXISTS idx_jobs_user_created
ON jobs (user_id, created_at DESC)
"""

_CREATE_FLAGGED_NAMES_TABLE = """
CREATE TABLE IF NOT EXISTS flagged_names (
    user_id    TEXT NOT NULL,
    name       TEXT NOT NULL,
    created_at REAL NOT NULL,
    PRIMARY KEY (user_id, name)
)
"""

_CREATE_BENCHMARK_RUNS_TABLE = """
CREATE TABLE IF NOT EXISTS benchmark_runs (
    run_id         TEXT PRIMARY KEY,
    user_id        TEXT,
    display_name   TEXT,
    dataset_name   TEXT,
    status         TEXT NOT NULL DEFAULT 'pending',
    error_message  TEXT,
    config         TEXT,
    vocabularies   TEXT,
    sdk_version    TEXT,
    env            TEXT NOT NULL DEFAULT 'production',
    base_url       TEXT,
    order_asserted INTEGER NOT NULL DEFAULT 0,
    input_names    TEXT,
    corpus_metrics TEXT,
    total          INTEGER NOT NULL DEFAULT 0,
    created_at     REAL NOT NULL,
    updated_at     REAL NOT NULL
)
"""

_CREATE_BENCHMARK_RUNS_INDEX = """
CREATE INDEX IF NOT EXISTS idx_bench_user_created
ON benchmark_runs (user_id, created_at DESC)
"""

_CREATE_BENCHMARK_ROW_LOGS_TABLE = """
CREATE TABLE IF NOT EXISTS benchmark_row_logs (
    run_id       TEXT NOT NULL,
    name         TEXT NOT NULL,
    vocabulary   TEXT NOT NULL,
    ground_truth TEXT,
    returned_ids TEXT,
    hit_ranks    TEXT,
    category     TEXT NOT NULL,
    first_hit    INTEGER
)
"""

_CREATE_BENCHMARK_ROW_LOGS_INDEX = """
CREATE INDEX IF NOT EXISTS idx_bench_rowlog_run
ON benchmark_row_logs (run_id)
"""


class Database:
    """Async SQLite persistence layer for job history."""

    def __init__(self) -> None:
        db_path = os.environ.get("BIOMAPPER_DB_PATH", "").strip()
        self._path = Path(db_path) if db_path else _DEFAULT_DB_PATH
        self._db: aiosqlite.Connection | None = None

    async def initialize(self) -> None:
        existed = self._path.exists()
        self._path.parent.mkdir(parents=True, exist_ok=True)

        self._db = await aiosqlite.connect(str(self._path))
        self._db.row_factory = aiosqlite.Row

        await self._conn.execute("PRAGMA journal_mode=WAL")
        await self._conn.execute(_CREATE_TABLE)
        await self._conn.execute(_CREATE_INDEX)
        await self._conn.execute(_CREATE_FLAGGED_NAMES_TABLE)
        await self._conn.execute(_CREATE_BENCHMARK_RUNS_TABLE)
        await self._conn.execute(_CREATE_BENCHMARK_RUNS_INDEX)
        await self._conn.execute(_CREATE_BENCHMARK_ROW_LOGS_TABLE)
        await self._conn.execute(_CREATE_BENCHMARK_ROW_LOGS_INDEX)
        await self._conn.commit()

        if existed:
            logger.info("Database loaded from %s", self._path)
        else:
            logger.info("Database created at %s (new file)", self._path)

    async def close(self) -> None:
        if self._db:
            await self._conn.close()
            self._db = None

    @property
    def _conn(self) -> aiosqlite.Connection:
        assert self._db is not None, "Database not initialized — call initialize() first"
        return self._db

    # ------------------------------------------------------------------
    # CRUD
    # ------------------------------------------------------------------

    async def insert_job(
        self,
        *,
        job_id: str,
        user_id: str | None,
        status: str = "pending",
        total: int = 0,
        env: str = "production",
        config: dict[str, Any] | None = None,
    ) -> None:
        now = time.time()
        config_json = json.dumps(config) if config is not None else None
        await self._conn.execute(
            """INSERT INTO jobs
               (job_id, user_id, status, total, completed, error_count,
                env, config, created_at, updated_at)
               VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?)""",
            (job_id, user_id, status, total, env, config_json, now, now),
        )
        await self._conn.commit()

    async def update_job(
        self,
        job_id: str,
        **fields: Any,
    ) -> None:
        if not fields:
            return

        allowed = {
            "status", "completed", "error_count", "error_message",
            "results", "config", "display_name",
        }
        parts: list[str] = []
        values: list[Any] = []
        for key, val in fields.items():
            if key not in allowed:
                continue
            if key in ("results", "config") and val is not None and not isinstance(val, str):
                val = json.dumps(val)
            parts.append(f"{key} = ?")
            values.append(val)

        if not parts:
            return

        parts.append("updated_at = ?")
        values.append(time.time())
        values.append(job_id)

        sql = f"UPDATE jobs SET {', '.join(parts)} WHERE job_id = ?"
        await self._conn.execute(sql, values)
        await self._conn.commit()

    async def get_job(self, job_id: str) -> dict[str, Any] | None:
        cursor = await self._conn.execute(
            "SELECT * FROM jobs WHERE job_id = ?", (job_id,)
        )
        row = await cursor.fetchone()
        if row is None:
            return None
        return self._row_to_dict(row, include_results=True)

    async def list_jobs(self, user_id: str) -> list[dict[str, Any]]:
        cursor = await self._conn.execute(
            """SELECT job_id, user_id, display_name, status, total, completed,
                      error_count, error_message, env, created_at, updated_at
               FROM jobs
               WHERE user_id = ?
               ORDER BY created_at DESC
               LIMIT 100""",
            (user_id,),
        )
        rows = await cursor.fetchall()
        return [self._row_to_dict(row, include_results=False) for row in rows]

    async def delete_job(self, job_id: str) -> bool:
        cursor = await self._conn.execute(
            "DELETE FROM jobs WHERE job_id = ?", (job_id,)
        )
        await self._conn.commit()
        return cursor.rowcount > 0

    async def recover_stale_jobs(self) -> int:
        cursor = await self._conn.execute(
            """UPDATE jobs
               SET status = 'error',
                   error_message = 'Job interrupted by server restart. Please re-run.',
                   updated_at = ?
               WHERE status IN ('pending', 'processing')""",
            (time.time(),),
        )
        await self._conn.commit()
        count = cursor.rowcount
        if count:
            logger.info("Recovered %d stale job(s) on startup", count)
        return count

    # ------------------------------------------------------------------
    # Flags CRUD
    # ------------------------------------------------------------------

    async def list_flags(self, user_id: str) -> list[str]:
        cursor = await self._conn.execute(
            "SELECT name FROM flagged_names WHERE user_id = ? ORDER BY created_at DESC",
            (user_id,),
        )
        rows = await cursor.fetchall()
        return [row[0] for row in rows]

    async def count_flags(self, user_id: str) -> int:
        cursor = await self._conn.execute(
            "SELECT COUNT(*) FROM flagged_names WHERE user_id = ?",
            (user_id,),
        )
        row = await cursor.fetchone()
        return row[0] if row else 0

    async def upsert_flag(self, user_id: str, name: str, cap: int = 1000) -> bool:
        """Insert flag if under cap. Returns True if inserted or already exists, False if cap reached."""
        cursor = await self._conn.execute(
            """INSERT OR IGNORE INTO flagged_names (user_id, name, created_at)
               SELECT ?, ?, ?
               WHERE (SELECT COUNT(*) FROM flagged_names WHERE user_id = ?) < ?""",
            (user_id, name, time.time(), user_id, cap),
        )
        await self._conn.commit()
        if cursor.rowcount > 0:
            return True  # Inserted
        # rowcount == 0: either duplicate (idempotent) or cap reached
        check = await self._conn.execute(
            "SELECT 1 FROM flagged_names WHERE user_id = ? AND name = ?",
            (user_id, name),
        )
        return (await check.fetchone()) is not None

    async def list_all_flags_aggregated(self) -> dict[str, Any]:
        """Return aggregated flag counts across all users, ordered by count descending."""
        cursor = await self._conn.execute(
            """WITH grouped AS (
                 SELECT name, COUNT(DISTINCT user_id) AS count
                 FROM flagged_names
                 GROUP BY name
               )
               SELECT name, count, COUNT(*) OVER () AS total
               FROM grouped
               ORDER BY count DESC
               LIMIT 1000"""
        )
        rows = list(await cursor.fetchall())
        if not rows:
            return {"items": [], "total": 0}
        total = rows[0][2]  # total from window function
        if len(rows) == 1000 and total > 1000:
            logger.debug("Flagged names truncated: returning 1000 of %d", total)
        items = [{"name": row[0], "count": row[1]} for row in rows]
        return {"items": items, "total": total}

    async def delete_flag(self, user_id: str, name: str) -> None:
        await self._conn.execute(
            "DELETE FROM flagged_names WHERE user_id = ? AND name = ?",
            (user_id, name),
        )
        await self._conn.commit()

    # ------------------------------------------------------------------
    # Benchmark runs CRUD
    # ------------------------------------------------------------------

    _BENCHMARK_JSON_FIELDS = ("config", "vocabularies", "input_names", "corpus_metrics")

    async def insert_benchmark_run(
        self,
        *,
        run_id: str,
        user_id: str | None,
        dataset_name: str | None,
        total: int,
        env: str,
        base_url: str | None,
        sdk_version: str | None,
        order_asserted: bool,
        config: dict[str, Any] | None,
        vocabularies: list[str] | None,
        input_names: list[str] | None,
        display_name: str | None = None,
        status: str = "pending",
    ) -> None:
        now = time.time()
        await self._conn.execute(
            """INSERT INTO benchmark_runs
               (run_id, user_id, display_name, dataset_name, status, config,
                vocabularies, sdk_version, env, base_url, order_asserted,
                input_names, total, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                run_id, user_id, display_name, dataset_name, status,
                json.dumps(config) if config is not None else None,
                json.dumps(vocabularies) if vocabularies is not None else None,
                sdk_version, env, base_url, 1 if order_asserted else 0,
                json.dumps(input_names) if input_names is not None else None,
                total, now, now,
            ),
        )
        await self._conn.commit()

    async def update_benchmark_run(self, run_id: str, **fields: Any) -> None:
        if not fields:
            return
        allowed = {
            "status", "error_message", "display_name", "corpus_metrics",
            "sdk_version", "order_asserted",
        }
        parts: list[str] = []
        values: list[Any] = []
        for key, val in fields.items():
            if key not in allowed:
                continue
            if key == "corpus_metrics" and val is not None and not isinstance(val, str):
                val = json.dumps(val)
            if key == "order_asserted":
                val = 1 if val else 0
            parts.append(f"{key} = ?")
            values.append(val)
        if not parts:
            return
        parts.append("updated_at = ?")
        values.append(time.time())
        values.append(run_id)
        await self._conn.execute(
            f"UPDATE benchmark_runs SET {', '.join(parts)} WHERE run_id = ?", values
        )
        await self._conn.commit()

    async def get_benchmark_run(self, run_id: str) -> dict[str, Any] | None:
        cursor = await self._conn.execute(
            "SELECT * FROM benchmark_runs WHERE run_id = ?", (run_id,)
        )
        row = await cursor.fetchone()
        if row is None:
            return None
        return self._benchmark_row_to_dict(row, include_heavy=True)

    async def list_benchmark_runs(self, user_id: str) -> list[dict[str, Any]]:
        cursor = await self._conn.execute(
            """SELECT run_id, user_id, display_name, dataset_name, status,
                      error_message, sdk_version, env, order_asserted, total,
                      corpus_metrics, created_at, updated_at
               FROM benchmark_runs
               WHERE user_id = ?
               ORDER BY created_at DESC
               LIMIT 100""",
            (user_id,),
        )
        rows = await cursor.fetchall()
        # input_names is intentionally excluded from the list response (can be up to 10k).
        return [self._benchmark_row_to_dict(row, include_heavy=False) for row in rows]

    async def delete_benchmark_run(self, run_id: str) -> bool:
        await self._conn.execute(
            "DELETE FROM benchmark_row_logs WHERE run_id = ?", (run_id,)
        )
        cursor = await self._conn.execute(
            "DELETE FROM benchmark_runs WHERE run_id = ?", (run_id,)
        )
        await self._conn.commit()
        return cursor.rowcount > 0

    async def insert_row_logs(self, run_id: str, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        payload = []
        for r in rows:
            hit_ranks = r.get("hit_ranks", "")
            first = None
            if hit_ranks:
                try:
                    first = int(str(hit_ranks).split(";")[0])
                except (ValueError, IndexError):
                    first = None
            payload.append((
                run_id, r.get("name"), r.get("vocabulary"), r.get("ground_truth"),
                r.get("returned_ids"), hit_ranks, r.get("category"), first,
            ))
        await self._conn.executemany(
            """INSERT INTO benchmark_row_logs
               (run_id, name, vocabulary, ground_truth, returned_ids, hit_ranks,
                category, first_hit)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            payload,
        )
        await self._conn.commit()

    async def get_row_logs(
        self,
        run_id: str,
        *,
        limit: int = 500,
        category: str | None = None,
        vocabulary: str | None = None,
        rerankable: bool = False,
    ) -> list[dict[str, Any]]:
        clauses = ["run_id = ?"]
        params: list[Any] = [run_id]
        if category:
            clauses.append("category = ?")
            params.append(category)
        if vocabulary:
            clauses.append("vocabulary = ?")
            params.append(vocabulary)
        if rerankable:
            # hit exists, not at rank 0, within top 5 (0-indexed): 0 < first_hit < 5
            clauses.append("first_hit IS NOT NULL AND first_hit > 0 AND first_hit < 5")
        params.append(limit)
        cursor = await self._conn.execute(
            f"""SELECT name, vocabulary, ground_truth, returned_ids, hit_ranks, category
                FROM benchmark_row_logs
                WHERE {' AND '.join(clauses)}
                LIMIT ?""",
            params,
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]

    async def recover_stale_benchmark_runs(self) -> int:
        cursor = await self._conn.execute(
            """UPDATE benchmark_runs
               SET status = 'interrupted',
                   error_message = 'Run interrupted by server restart. Please re-run.',
                   updated_at = ?
               WHERE status IN ('pending', 'processing')""",
            (time.time(),),
        )
        await self._conn.commit()
        count = cursor.rowcount
        if count:
            logger.info("Recovered %d stale benchmark run(s) on startup", count)
        return count

    @staticmethod
    def _benchmark_row_to_dict(row: aiosqlite.Row, *, include_heavy: bool) -> dict[str, Any]:
        d: dict[str, Any] = dict(row)
        d["order_asserted"] = bool(d.get("order_asserted"))
        for field in ("config", "vocabularies", "input_names", "corpus_metrics"):
            if field in d:
                d[field] = json.loads(d[field]) if d.get(field) else None
        return d

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _row_to_dict(row: aiosqlite.Row, *, include_results: bool) -> dict[str, Any]:
        d: dict[str, Any] = dict(row)
        if include_results:
            if d.get("results"):
                d["results"] = json.loads(d["results"])
            else:
                d["results"] = []
            if d.get("config"):
                d["config"] = json.loads(d["config"])
            else:
                d["config"] = None
        return d


database = Database()
