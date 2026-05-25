from fastapi import APIRouter, Header, HTTPException, Query

from services.database import database

router = APIRouter()

_MAX_NAME_LENGTH = 500
_MAX_FLAGS_PER_USER = 1000


@router.get("")
async def list_flags(
    x_clerk_user_id: str | None = Header(None),
) -> list[str]:
    if x_clerk_user_id is None:
        raise HTTPException(status_code=400, detail="Missing x-clerk-user-id header")
    return await database.list_flags(x_clerk_user_id)


@router.get("/all")
async def list_all_flags_aggregated(
    x_clerk_user_id: str | None = Header(None),
) -> dict:
    if x_clerk_user_id is None:
        raise HTTPException(status_code=400, detail="Missing x-clerk-user-id header")
    return await database.list_all_flags_aggregated()


@router.put("", status_code=204)
async def create_flag(
    name: str = Query(..., min_length=1, max_length=_MAX_NAME_LENGTH),
    x_clerk_user_id: str | None = Header(None),
) -> None:
    if x_clerk_user_id is None:
        raise HTTPException(status_code=400, detail="Missing x-clerk-user-id header")
    ok = await database.upsert_flag(x_clerk_user_id, name, cap=_MAX_FLAGS_PER_USER)
    if not ok:
        raise HTTPException(status_code=409, detail="Flag limit reached (max 1000)")


@router.delete("", status_code=204)
async def delete_flag(
    name: str = Query(..., min_length=1, max_length=_MAX_NAME_LENGTH),
    x_clerk_user_id: str | None = Header(None),
) -> None:
    if x_clerk_user_id is None:
        raise HTTPException(status_code=400, detail="Missing x-clerk-user-id header")
    await database.delete_flag(x_clerk_user_id, name)
