import logging
import os

from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.responses import JSONResponse

from models.feedback import FeedbackRequest
from services.feedback_store import feedback_store

logger = logging.getLogger("entity-linker")

router = APIRouter()

_FEEDBACK_API_KEY = os.environ.get("FEEDBACK_API_KEY", "")


@router.post("")
async def submit_feedback(
    feedback: FeedbackRequest,
    x_clerk_user_id: str | None = Header(None),
) -> JSONResponse:
    if x_clerk_user_id is None:
        raise HTTPException(status_code=400, detail="Missing x-clerk-user-id header")

    feedback_id = await feedback_store.save(feedback)
    masked_email = (
        feedback.user_email[:3] + "...@" + feedback.user_email.split("@")[-1]
        if "@" in feedback.user_email
        else feedback.user_email[:3] + "..."
    )
    logger.info(
        "Feedback received: category=%s user=%s id=%s",
        feedback.category,
        masked_email,
        feedback_id,
    )
    return JSONResponse(
        status_code=201,
        content={"id": feedback_id, "status": "received"},
    )


@router.get("")
async def list_feedback(
    category: str | None = Query(None, pattern="^(annotation_issue|feature_request|ui_error)$"),
    limit: int = Query(100, ge=1, le=1000),
    x_api_key: str | None = Header(None),
) -> list[dict]:
    if not _FEEDBACK_API_KEY or x_api_key != _FEEDBACK_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing API key")
    return await feedback_store.query(category=category, limit=limit)
