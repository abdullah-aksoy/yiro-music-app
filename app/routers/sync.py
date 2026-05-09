from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.models.favorite import Favorite
from app.models.listening_history import ListeningHistory
from app.models.playlist import Playlist, PlaylistFollow
from app.models.user import User
from app.schemas.sync import SyncChangesOut, SyncFavoriteChangeOut, SyncHistoryChangeOut, SyncPlaylistChangeOut
from app.utils.deps import get_current_user

router = APIRouter(prefix="/sync", tags=["sync"])


def _normalize_since(since: datetime) -> datetime:
    if since.tzinfo is None:
        return since.replace(tzinfo=UTC)
    return since.astimezone(UTC)


@router.get(
    "/changes",
    response_model=SyncChangesOut,
    summary="Get incremental changes",
    description="Returns playlist/favorite/history changes since timestamp for current user.",
)
async def get_changes(
    since: datetime = Query(description="ISO timestamp cursor."),
    playlist_limit: int = Query(default=200, ge=1, le=1000),
    favorite_limit: int = Query(default=200, ge=1, le=1000),
    history_limit: int = Query(default=200, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> SyncChangesOut:
    normalized_since = _normalize_since(since)
    followed_ids = set(
        (
            await db.execute(
                select(PlaylistFollow.playlist_id).where(PlaylistFollow.user_id == current_user.id)
            )
        ).scalars().all()
    )
    playlist_stmt = (
        select(Playlist)
        .options(selectinload(Playlist.user))
        .where(
            or_(
                Playlist.user_id == current_user.id,
                and_(
                    Playlist.id.in_(list(followed_ids) or [-1]),
                    Playlist.is_public.is_(True),
                ),
            ),
            Playlist.updated_at > normalized_since,
        )
        .order_by(Playlist.updated_at.desc())
        .limit(playlist_limit)
    )
    playlist_rows = (await db.execute(playlist_stmt)).scalars().all()
    playlists = [
        SyncPlaylistChangeOut(
            playlist_id=item.id,
            name=item.name,
            owner_username=item.user.username if item.user else "unknown",
            is_public=item.is_public,
            updated_at=item.updated_at,
        )
        for item in playlist_rows
    ]

    favorite_rows = (
        await db.execute(
            select(Favorite)
            .where(Favorite.user_id == current_user.id, Favorite.created_at > normalized_since)
            .order_by(Favorite.created_at.desc())
            .limit(favorite_limit)
        )
    ).scalars().all()
    favorites = [
        SyncFavoriteChangeOut(song_id=item.song_id, created_at=item.created_at)
        for item in favorite_rows
    ]

    history_rows = (
        await db.execute(
            select(ListeningHistory)
            .where(ListeningHistory.user_id == current_user.id, ListeningHistory.listened_at > normalized_since)
            .order_by(ListeningHistory.listened_at.desc())
            .limit(history_limit)
        )
    ).scalars().all()
    history = [
        SyncHistoryChangeOut(
            history_id=item.id,
            song_id=item.song_id,
            listened_at=item.listened_at,
            listened_duration_ms=item.listened_duration_ms,
        )
        for item in history_rows
    ]

    return SyncChangesOut(
        since=normalized_since,
        server_time=datetime.now(UTC),
        playlists=playlists,
        favorites=favorites,
        history=history,
    )
