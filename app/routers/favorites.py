from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.favorite import Favorite
from app.models.song import Song
from app.models.user import User
from app.schemas.song import ITunesTrackIn, SongOut
from app.services.song_store import get_or_create_song_from_itunes
from app.utils.cache import (
    cache_response,
    invalidate_user_endpoint_cache,
    invalidate_user_library_summary_stats_cache,
)
from app.utils.deps import get_current_user

router = APIRouter(prefix="/favorites", tags=["favorites"])
_FAV_MOD = "app.routers.favorites"


async def _invalidate_favorites_list_cache(user_id: int) -> None:
    await invalidate_user_endpoint_cache(
        user_id,
        key_prefix="favorites_list",
        module=_FAV_MOD,
        function_name="list_favorites",
    )


@router.get(
    "",
    response_model=list[SongOut],
    summary="List favorites",
    description="Lists favorite songs. (Kullanicinin favori sarkilarini listeler.)",
)
@cache_response("favorites_list", ttl=45)
async def list_favorites(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[Song]:
    stmt = (
        select(Song)
        .join(Favorite, Favorite.song_id == Song.id)
        .where(Favorite.user_id == current_user.id)
        .order_by(Favorite.created_at.desc())
    )
    return list((await db.execute(stmt)).scalars().all())


@router.post(
    "/by-itunes",
    status_code=status.HTTP_201_CREATED,
    summary="Add favorite from iTunes fields",
    description="Creates or finds a song from iTunes form fields, then adds it to favorites. (iTunes form alanlari ile sarki olusturur veya bulur, sonra favoriye ekler.)",
)
async def add_favorite_by_itunes(
    payload: Annotated[ITunesTrackIn, Depends(ITunesTrackIn.as_form)],
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    if not payload.has_track_data():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="iTunes payload is required",
        )

    try:
        song = await get_or_create_song_from_itunes(db, payload.to_itunes_payload())
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Song conflict while creating from iTunes metadata",
        ) from exc
    existing = await db.scalar(
        select(Favorite).where(Favorite.user_id == current_user.id, Favorite.song_id == song.id)
    )
    if existing:
        await db.rollback()
        return {"message": "Already in favorites", "song_id": song.id}

    db.add(Favorite(user_id=current_user.id, song_id=song.id))
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        return {"message": "Already in favorites", "song_id": song.id}
    await invalidate_user_library_summary_stats_cache(current_user.id)
    await _invalidate_favorites_list_cache(current_user.id)
    return {"message": "Added to favorites", "song_id": song.id}


@router.post(
    "/{song_id}",
    status_code=status.HTTP_201_CREATED,
    summary="Add favorite",
    description="Adds a song to favorites by id. (Sarki ID ile favorilere ekler.)",
)
async def add_favorite(
    song_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    song = await db.scalar(select(Song).where(Song.id == song_id))
    if not song:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Song not found")

    existing = await db.scalar(
        select(Favorite).where(Favorite.user_id == current_user.id, Favorite.song_id == song_id)
    )
    if existing:
        return {"message": "Already in favorites", "song_id": song_id}

    db.add(Favorite(user_id=current_user.id, song_id=song_id))
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        return {"message": "Already in favorites", "song_id": song_id}
    await invalidate_user_library_summary_stats_cache(current_user.id)
    await _invalidate_favorites_list_cache(current_user.id)
    return {"message": "Added to favorites", "song_id": song_id}


@router.delete(
    "/{song_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Remove favorite",
    description="Removes song from favorites. (Sarkiyi favorilerden kaldirir.)",
)
async def delete_favorite(
    song_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    favorite = await db.scalar(
        select(Favorite).where(Favorite.user_id == current_user.id, Favorite.song_id == song_id)
    )
    if not favorite:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Favorite not found")

    await db.delete(favorite)
    await db.commit()
    await invalidate_user_library_summary_stats_cache(current_user.id)
    await _invalidate_favorites_list_cache(current_user.id)
    return None

