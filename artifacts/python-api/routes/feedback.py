import logging
import os

from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.responses import JSONResponse

from models.feedback import FeedbackRequest
from services.feedback_store import feedback_store

logger = logging.getLogger("entity-linker")

router = APIRouter()


@router.post("")
async def submit_feedback(feedback: FeedbackRequest) -> JSONResponse:
    feedback_id = await feedback_store.save(feedback)
    logger.info(
        "Feedback received: category=%s user=%s id=%s",
        feedback.category,
        feedback.user_email,
        feedback_id,
    )
    return JSONResponse(
        status_code=201,
        content={"id": feedback_id, "status": "received"},
    )


@router.get("")
async def list_feedback(
    category: str | None = Query(None, pattern="^(annotation_issue|feature_request|ui_error)$"),
    x_clerk_user_id: str | None = Header(None),
) -> list[dict]:
    if x_clerk_user_id is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    # Only allow in local dev — production feedback is reviewed via direct DB access
    if os.environ.get("ENVIRONMENT", "production") != "development":
        raise HTTPException(status_code=403, detail="Admin access only")
    return await feedback_store.query(category=category)
