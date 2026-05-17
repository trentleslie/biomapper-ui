import logging

from fastapi import APIRouter, Query
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
) -> list[dict]:
    return await feedback_store.query(category=category)
