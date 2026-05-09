from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import delete, desc, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.models.listening_history import ListeningHistory
from app.models.song import Song
from app.models.user import User
from app.schemas.history import (
    ArtistListenerProfileOut,
    ListeningHistoryCreate,
    ListeningHistoryCreateByItunes,
    ListeningHistoryDetailedOut,
    ListeningHistoryOut,
)
from app.services.song_store import get_or_create_song_from_itunes
from app.utils.cache import (
    cache_response,
    invalidate_user_handler_cache_variants,
    invalidate_user_library_summary_stats_cache,
)
from app.utils.deps import get_current_user
from app.utils.sql_safe import LIKE_ESCAPE_CHAR, escape_like_pattern

router = APIRouter(prefix="/history", tags=["history"])
_HISTORY_MOD = "app.routers.history"


async def _invalidate_history_read_caches(user_id: int) -> None:
    for prefix, fn in (
        ("history_list", "list_history"),
        ("history_recent", "list_recent_history"),
        ("history_artist_listeners", "list_artist_listeners"),
    ):
        await invalidate_user_handler_cache_variants(
            user_id,
            key_prefix=prefix,
            module=_HISTORY_MOD,
            function_name=fn,
        )


@router.post(
    "",
    response_model=ListeningHistoryOut,
    status_code=status.HTTP_201_CREATED,
    summary="Add listening history",
    description="Stores a listening history row. (Dinlenen sarki bilgisini kaydeder.)",
)
async def add_history(
    payload: Annotated[ListeningHistoryCreate, Depends(ListeningHistoryCreate.as_form)],
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ListeningHistory:
    song = await db.scalar(select(Song).where(Song.id == payload.song_id))
    if not song:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Song not found")

    item = ListeningHistory(
        user_id=current_user.id,
        song_id=payload.song_id,
        source_type="local" if song.is_local else "itunes",
        track_title=song.title,
        track_artist=song.artist,
        track_album=song.album,
        track_genre=song.genre,
        track_duration_ms=song.duration_ms,
        track_artwork_url=song.artwork_url,
        track_preview_url=song.preview_url,
        track_itunes_id=song.itunes_track_id,
        listened_duration_ms=payload.listened_duration_ms,
    )
    db.add(item)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="History entry conflicts with database constraints",
        ) from exc
    await db.refresh(item)
    await invalidate_user_library_summary_stats_cache(current_user.id)
    await _invalidate_history_read_caches(current_user.id)
    return item


@router.post(
    "/by-itunes",
    response_model=ListeningHistoryOut,
    status_code=status.HTTP_201_CREATED,
    summary="Add listening history by iTunes metadata",
    description="Stores listening history by creating/finding a song via iTunes fields.",
)
async def add_history_by_itunes(
    payload: Annotated[ListeningHistoryCreateByItunes, Depends(ListeningHistoryCreateByItunes.as_form)],
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ListeningHistory:
    if not payload.has_track_data():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="iTunes payload is required for history entry",
        )

    try:
        song = await get_or_create_song_from_itunes(db, payload.to_itunes_payload())
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Song conflict while creating from iTunes metadata",
        ) from exc

    item = ListeningHistory(
        user_id=current_user.id,
        song_id=song.id,
        source_type="local" if song.is_local else "itunes",
        track_title=song.title,
        track_artist=song.artist,
        track_album=song.album,
        track_genre=song.genre,
        track_duration_ms=song.duration_ms,
        track_artwork_url=song.artwork_url,
        track_preview_url=song.preview_url,
        track_itunes_id=song.itunes_track_id,
        listened_duration_ms=payload.listened_duration_ms,
    )
    db.add(item)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="History entry conflicts with database constraints",
        ) from exc
    await db.refresh(item)
    await invalidate_user_library_summary_stats_cache(current_user.id)
    await _invalidate_history_read_caches(current_user.id)
    return item


@router.get(
    "/artist-listeners",
    response_model=list[ArtistListenerProfileOut],
    summary="List users listening to artist",
    description="Returns user profiles who listened to tracks by the given artist.",
)
@cache_response("history_artist_listeners", ttl=45)
async def list_artist_listeners(
    artist: str = Query(..., min_length=1, max_length=255),
    limit: int = Query(default=24, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[ArtistListenerProfileOut]:
    safe_artist = artist.strip()
    if not safe_artist:
        return []
    stmt = (
        select(
            ListeningHistory.user_id,
            User.username,
            User.avatar_url,
            User.bio,
            func.count(ListeningHistory.id).label("play_count"),
            func.max(ListeningHistory.listened_at).label("last_listened_at"),
        )
        .join(User, User.id == ListeningHistory.user_id)
        .where(
            ListeningHistory.track_artist.ilike(
                escape_like_pattern(safe_artist),
                escape=LIKE_ESCAPE_CHAR,
            )
        )
        .group_by(ListeningHistory.user_id, User.username, User.avatar_url, User.bio)
        .order_by(desc("play_count"), desc("last_listened_at"))
        .limit(limit)
    )
    rows = (await db.execute(stmt)).all()
    return [
        ArtistListenerProfileOut(
            user_id=int(row.user_id),
            username=str(row.username),
            avatar_url=str(row.avatar_url) if row.avatar_url else None,
            bio=str(row.bio) if row.bio else None,
            play_count=int(row.play_count or 0),
            last_listened_at=row.last_listened_at,
        )
        for row in rows
        if row.last_listened_at is not None
    ]


@router.get(
    "",
    response_model=list[ListeningHistoryDetailedOut],
    summary="List listening history",
    description="Returns current user's listening history. (Kullanicinin dinleme gecmisini listeler.)",
)
@cache_response("history_list", ttl=30)
async def list_history(
    limit: int = Query(default=100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[ListeningHistory]:
    stmt = (
        select(ListeningHistory)
        .options(selectinload(ListeningHistory.song))
        .where(ListeningHistory.user_id == current_user.id)
        .order_by(ListeningHistory.listened_at.desc())
        .limit(limit)
    )
    return list((await db.execute(stmt)).scalars().all())


@router.get(
    "/recent",
    response_model=list[ListeningHistoryDetailedOut],
    summary="List recent plays",
    description="Returns lightweight recent listening history.",
)
@cache_response("history_recent", ttl=30)
async def list_recent_history(
    limit: int = Query(default=20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[ListeningHistory]:
    stmt = (
        select(ListeningHistory)
        .options(selectinload(ListeningHistory.song))
        .where(ListeningHistory.user_id == current_user.id)
        .order_by(ListeningHistory.listened_at.desc())
        .limit(limit)
    )
    return list((await db.execute(stmt)).scalars().all())


@router.delete(
    "/{history_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete one history row",
    description="Deletes a single listening history row for current user.",
)
async def delete_history_item(
    history_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    item = await db.scalar(
        select(ListeningHistory).where(
            ListeningHistory.id == history_id,
            ListeningHistory.user_id == current_user.id,
        )
    )
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="History row not found")
    await db.delete(item)
    await db.commit()
    await invalidate_user_library_summary_stats_cache(current_user.id)
    await _invalidate_history_read_caches(current_user.id)
    return None


@router.delete(
    "",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Clear history",
    description="Deletes all listening history rows for current user.",
)
async def clear_history(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    await db.execute(delete(ListeningHistory).where(ListeningHistory.user_id == current_user.id))
    await db.commit()
    await invalidate_user_library_summary_stats_cache(current_user.id)
    await _invalidate_history_read_caches(current_user.id)
    return None

