"""
Standalone dev server for testing the feedback feature only.
Run: uvicorn dev_feedback_only:app --reload --port 8000

This avoids importing the biomapper package which is not available locally.
"""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routes.feedback import router as feedback_router
from services.feedback_store import feedback_store


@asynccontextmanager
async def lifespan(app):
    await feedback_store.init_db()
    yield


app = FastAPI(title="Feedback Dev Server", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(feedback_router, prefix="/feedback")


@app.get("/health")
async def health():
    return {"status": "ok"}
