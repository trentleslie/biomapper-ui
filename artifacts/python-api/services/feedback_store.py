import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

import aiosqlite

_DEFAULT_DB_PATH = str(Path(__file__).resolve().parent.parent / "data" / "feedback.db")


class FeedbackStore:
    def __init__(self, db_path: str = _DEFAULT_DB_PATH) -> None:
        self._db_path = db_path

    async def init_db(self) -> None:
        Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
        async with aiosqlite.connect(self._db_path) as db:
            await db.execute("PRAGMA journal_mode=WAL")
            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS feedback (
                    id TEXT PRIMARY KEY,
                    category TEXT NOT NULL,
                    description TEXT NOT NULL,
                    metadata TEXT NOT NULL,
                    user_email TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            await db.commit()

    async def save(self, feedback: Any) -> str:
        feedback_id = str(uuid4())
        created_at = datetime.now(timezone.utc).isoformat()
        metadata_json = feedback.metadata.model_dump_json(by_alias=True)

        async with aiosqlite.connect(self._db_path) as db:
            await db.execute(
                """
                INSERT INTO feedback (id, category, description, metadata, user_email, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    feedback_id,
                    feedback.category,
                    feedback.description,
                    metadata_json,
                    feedback.user_email,
                    created_at,
                ),
            )
            await db.commit()
        return feedback_id

    async def query(self, category: str | None = None) -> list[dict[str, Any]]:
        async with aiosqlite.connect(self._db_path) as db:
            db.row_factory = aiosqlite.Row
            if category:
                cursor = await db.execute(
                    "SELECT * FROM feedback WHERE category = ? ORDER BY created_at DESC",
                    (category,),
                )
            else:
                cursor = await db.execute(
                    "SELECT * FROM feedback ORDER BY created_at DESC"
                )
            rows = await cursor.fetchall()
            return [
                {
                    "id": row["id"],
                    "category": row["category"],
                    "description": row["description"],
                    "metadata": json.loads(row["metadata"]),
                    "user_email": row["user_email"],
                    "created_at": row["created_at"],
                }
                for row in rows
            ]


feedback_store = FeedbackStore()
