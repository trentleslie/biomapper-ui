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

    async def delete_flag(self, user_id: str, name: str) -> None:
        await self._conn.execute(
            "DELETE FROM flagged_names WHERE user_id = ? AND name = ?",
            (user_id, name),
        )
        await self._conn.commit()

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
