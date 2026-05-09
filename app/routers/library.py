from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.favorite import Favorite
from app.models.library_collection import SavedAlbum, SavedArtist
from app.models.listening_history import ListeningHistory
from app.models.playlist import Playlist
from app.models.song import Song
from app.models.user import User
from app.schemas.library import (
    GenreCountOut,
    LibraryCollectionsOut,
    LibraryStatsOut,
    LibrarySummaryOut,
    SavedAlbumIn,
    SavedAlbumOut,
    SavedArtistIn,
    SavedArtistOut,
)
from app.utils.cache import cache_response, invalidate_user_endpoint_cache
from app.utils.deps import get_current_user

router = APIRouter(prefix="/library", tags=["library"])
_LIB_MOD = "app.routers.library"


async def _invalidate_library_collections_cache(user_id: int) -> None:
    await invalidate_user_endpoint_cache(
        user_id,
        key_prefix="library_collections",
        module=_LIB_MOD,
        function_name="get_library_collections",
    )


@router.get(
    "/summary",
    response_model=LibrarySummaryOut,
    summary="Library summary",
    description="Returns summary counts for current user's library.",
)
@cache_response("library_summary", ttl=60)
async def get_library_summary(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> LibrarySummaryOut:
    week_ago = datetime.now(UTC) - timedelta(days=7)
    uid = current_user.id
    favorites_sq = (
        select(func.count()).select_from(Favorite).where(Favorite.user_id == uid).scalar_subquery()
    )
    playlists_sq = (
        select(func.count()).select_from(Playlist).where(Playlist.user_id == uid).scalar_subquery()
    )
    total_listen_ms_sq = (
        select(func.coalesce(func.sum(ListeningHistory.listened_duration_ms), 0))
        .where(ListeningHistory.user_id == uid)
        .scalar_subquery()
    )
    recent_plays_sq = (
        select(func.count())
        .select_from(ListeningHistory)
        .where(ListeningHistory.user_id == uid, ListeningHistory.listened_at >= week_ago)
        .scalar_subquery()
    )
    row = (
        await db.execute(
            select(favorites_sq, playlists_sq, total_listen_ms_sq, recent_plays_sq),
        )
    ).one()

    return LibrarySummaryOut(
        favorites_count=int(row[0] or 0),
        playlists_count=int(row[1] or 0),
        total_listen_ms=int(row[2] or 0),
        recent_plays_count=int(row[3] or 0),
    )


@router.get(
    "/stats",
    response_model=LibraryStatsOut,
    summary="Library stats",
    description="Returns extended listening metrics and top genres. (Genisletilmis dinleme metriklerini ve ust turleri dondurur.)",
)
@cache_response("library_stats", ttl=60)
async def get_library_stats(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> LibraryStatsOut:
    now = datetime.now(UTC)
    week_ago = now - timedelta(days=7)
    month_ago = now - timedelta(days=30)

    total_listen_ms = int(
        (
            await db.scalar(
                select(func.coalesce(func.sum(ListeningHistory.listened_duration_ms), 0)).where(
                    ListeningHistory.user_id == current_user.id
                )
            )
        )
        or 0
    )
    last_7_days_listen_ms = int(
        (
            await db.scalar(
                select(func.coalesce(func.sum(ListeningHistory.listened_duration_ms), 0)).where(
                    ListeningHistory.user_id == current_user.id,
                    ListeningHistory.listened_at >= week_ago,
                )
            )
        )
        or 0
    )
    last_30_days_listen_ms = int(
        (
            await db.scalar(
                select(func.coalesce(func.sum(ListeningHistory.listened_duration_ms), 0)).where(
                    ListeningHistory.user_id == current_user.id,
                    ListeningHistory.listened_at >= month_ago,
                )
            )
        )
        or 0
    )

    genre_rows = (
        await db.execute(
            select(Song.genre, func.count(ListeningHistory.id))
            .join(ListeningHistory, ListeningHistory.song_id == Song.id)
            .where(
                ListeningHistory.user_id == current_user.id,
                Song.genre.is_not(None),
            )
            .group_by(Song.genre)
            .order_by(func.count(ListeningHistory.id).desc())
            .limit(5)
        )
    ).all()

    top_genres = [
        GenreCountOut(genre=str(row[0]), plays=int(row[1]))
        for row in genre_rows
        if row[0]
    ]

    return LibraryStatsOut(
        total_listen_ms=total_listen_ms,
        last_7_days_listen_ms=last_7_days_listen_ms,
        last_30_days_listen_ms=last_30_days_listen_ms,
        top_genres=top_genres,
    )


@router.get(
    "/collections",
    response_model=LibraryCollectionsOut,
    summary="Library collections",
    description="Returns saved artist/album collections for current user.",
)
@cache_response("library_collections", ttl=120)
async def get_library_collections(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> LibraryCollectionsOut:
    saved_artists = list(
        (
            await db.execute(
                select(SavedArtist).where(SavedArtist.user_id == current_user.id).order_by(SavedArtist.created_at.desc())
            )
        )
        .scalars()
        .all()
    )
    saved_albums = list(
        (
            await db.execute(
                select(SavedAlbum).where(SavedAlbum.user_id == current_user.id).order_by(SavedAlbum.created_at.desc())
            )
        )
        .scalars()
        .all()
    )
    return LibraryCollectionsOut(
        saved_artists=[SavedArtistOut.model_validate(item) for item in saved_artists],
        saved_albums=[SavedAlbumOut.model_validate(item) for item in saved_albums],
    )


@router.post(
    "/collections/artists",
    response_model=SavedArtistOut,
    status_code=201,
    summary="Save artist",
    description="Adds an artist to current user's saved artist collection.",
)
async def save_artist(
    payload: SavedArtistIn,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> SavedArtistOut:
    normalized = payload.artist_name.strip()
    existing = await db.scalar(
        select(SavedArtist).where(SavedArtist.user_id == current_user.id, SavedArtist.artist_name == normalized)
    )
    if existing:
        return SavedArtistOut.model_validate(existing)
    item = SavedArtist(user_id=current_user.id, artist_name=normalized)
    db.add(item)
    await db.commit()
    await db.refresh(item)
    await _invalidate_library_collections_cache(current_user.id)
    return SavedArtistOut.model_validate(item)


@router.delete(
    "/collections/artists/{artist_id:int}",
    status_code=204,
    summary="Remove saved artist",
    description="Deletes one saved artist collection item.",
)
async def delete_saved_artist(
    artist_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    item = await db.scalar(select(SavedArtist).where(SavedArtist.id == artist_id, SavedArtist.user_id == current_user.id))
    if item:
        await db.delete(item)
        await db.commit()
        await _invalidate_library_collections_cache(current_user.id)
    return None


@router.post(
    "/collections/albums",
    response_model=SavedAlbumOut,
    status_code=201,
    summary="Save album",
    description="Adds an album to current user's saved albums collection.",
)
async def save_album(
    payload: SavedAlbumIn,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> SavedAlbumOut:
    title = payload.album_title.strip()
    artist = payload.artist_name.strip() if payload.artist_name else None
    existing = await db.scalar(
        select(SavedAlbum).where(
            SavedAlbum.user_id == current_user.id,
            SavedAlbum.album_title == title,
            SavedAlbum.artist_name == artist,
        )
    )
    if existing:
        return SavedAlbumOut.model_validate(existing)
    item = SavedAlbum(user_id=current_user.id, album_title=title, artist_name=artist)
    db.add(item)
    await db.commit()
    await db.refresh(item)
    await _invalidate_library_collections_cache(current_user.id)
    return SavedAlbumOut.model_validate(item)


@router.delete(
    "/collections/albums/{album_id:int}",
    status_code=204,
    summary="Remove saved album",
    description="Deletes one saved album collection item.",
)
async def delete_saved_album(
    album_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    item = await db.scalar(select(SavedAlbum).where(SavedAlbum.id == album_id, SavedAlbum.user_id == current_user.id))
    if item:
        await db.delete(item)
        await db.commit()
        await _invalidate_library_collections_cache(current_user.id)
    return None
