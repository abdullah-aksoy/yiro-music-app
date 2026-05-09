from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.models.playlist import Playlist, PlaylistFollow
from app.models.user import User
from app.schemas.sync import NotificationOut
from app.utils.deps import get_current_user

router = APIRouter(prefix="/notifications", tags=["notifications"])


def _normalize_since(since: datetime | None) -> datetime | None:
    if since is None:
        return None
    if since.tzinfo is None:
        return since.replace(tzinfo=UTC)
    return since.astimezone(UTC)


@router.get(
    "",
    response_model=list[NotificationOut],
    summary="Get notifications",
    description="Returns notification-like events derived from followed playlist updates.",
)
async def get_notifications(
    since: datetime | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[NotificationOut]:
    normalized_since = _normalize_since(since)
    stmt = (
        select(Playlist)
        .join(PlaylistFollow, PlaylistFollow.playlist_id == Playlist.id)
        .options(selectinload(Playlist.user))
        .where(
            PlaylistFollow.user_id == current_user.id,
            Playlist.is_public.is_(True),
        )
        .order_by(Playlist.updated_at.desc())
        .limit(limit)
    )
    if normalized_since is not None:
        stmt = stmt.where(Playlist.updated_at >= normalized_since)
    items = list((await db.execute(stmt)).scalars().all())
    return [
        NotificationOut(
            type="playlist_updated",
            playlist_id=item.id,
            playlist_name=item.name,
            owner_username=item.user.username if item.user else "unknown",
            occurred_at=item.updated_at,
        )
        for item in items
    ]
