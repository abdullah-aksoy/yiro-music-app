from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.models.playlist import Playlist, PlaylistFollow, PlaylistSong
from app.models.song import Song
from app.models.user import User
from app.schemas.playlist import (
    PlaylistCreate,
    PlaylistDetail,
    PlaylistFeedItemOut,
    PlaylistFollowOut,
    PlaylistFollowerOut,
    PlaylistOut,
    PlaylistSongAdd,
    PlaylistSongReorderIn,
    PlaylistStatsOut,
    PlaylistUpdate,
    PlaylistVisibilityUpdate,
)
from app.schemas.song import SongOut
from app.services.song_store import get_or_create_song_from_itunes
from app.utils.cache import (
    cache_response,
    invalidate_user_endpoint_cache,
    invalidate_user_handler_cache_variants,
    invalidate_user_library_summary_stats_cache,
)
from app.utils.deps import get_current_user

router = APIRouter(prefix="/playlists", tags=["playlists"])
_PLAY_MOD = "app.routers.playlists"


async def _invalidate_owned_playlists_cache(user_id: int) -> None:
    await invalidate_user_endpoint_cache(
        user_id,
        key_prefix="playlists_owned",
        module=_PLAY_MOD,
        function_name="list_playlists",
    )


async def _invalidate_follow_mirror_caches(user_id: int) -> None:
    """User's followed-playlist list, discover (is_followed flags), and feed depend on PlaylistFollow rows."""
    await invalidate_user_endpoint_cache(
        user_id,
        key_prefix="playlists_following",
        module=_PLAY_MOD,
        function_name="list_following_playlists",
    )
    await invalidate_user_handler_cache_variants(
        user_id,
        key_prefix="playlists_discover",
        module=_PLAY_MOD,
        function_name="discover_public_playlists",
    )
    await invalidate_user_handler_cache_variants(
        user_id,
        key_prefix="playlists_following_feed",
        module=_PLAY_MOD,
        function_name="following_feed",
    )


def _is_duplicate_playlist_song_error(exc: IntegrityError) -> bool:
    # asyncpg exposes SQLSTATE 23505 for unique violations.
    sqlstate = getattr(exc.orig, "sqlstate", None) or getattr(exc.orig, "pgcode", None)
    if sqlstate == "23505":
        constraint_name = getattr(exc.orig, "constraint_name", "")
        if constraint_name == "uq_playlist_song":
            return True
    message = str(exc.orig).lower()
    return (
        "uq_playlist_song" in message
        or ("unique" in message and "playlist_id" in message and "song_id" in message)
    )


def _to_playlist_out(playlist: Playlist, *, is_followed: bool = False) -> PlaylistOut:
    return PlaylistOut(
        id=playlist.id,
        user_id=playlist.user_id,
        owner_username=playlist.user.username if playlist.user else "unknown",
        name=playlist.name,
        description=playlist.description,
        is_public=playlist.is_public,
        created_at=playlist.created_at,
        updated_at=playlist.updated_at,
        is_followed=is_followed,
    )


def _touch_playlist(playlist: Playlist) -> None:
    playlist.updated_at = datetime.now(UTC)


def _normalize_since(since: datetime | None) -> datetime | None:
    if since is None:
        return None
    if since.tzinfo is None:
        return since.replace(tzinfo=UTC)
    return since.astimezone(UTC)


@router.get(
    "",
    response_model=list[PlaylistOut],
    summary="List playlists",
    description="Lists playlists of current user. (Kullanicinin playlistlerini listeler.)",
)
@cache_response("playlists_owned", ttl=45)
async def list_playlists(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[Playlist]:
    stmt = (
        select(Playlist)
        .options(selectinload(Playlist.user))
        .where(Playlist.user_id == current_user.id)
        .order_by(Playlist.created_at.desc())
    )
    items = list((await db.execute(stmt)).scalars().all())
    return [_to_playlist_out(item) for item in items]


@router.post(
    "",
    response_model=PlaylistOut,
    status_code=status.HTTP_201_CREATED,
    summary="Create playlist",
    description="Creates a new playlist. (Yeni playlist olusturur.)",
)
async def create_playlist(
    payload: Annotated[PlaylistCreate, Depends(PlaylistCreate.as_form)],
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Playlist:
    playlist = Playlist(user_id=current_user.id, name=payload.name, description=payload.description)
    db.add(playlist)
    await db.commit()
    await invalidate_user_library_summary_stats_cache(current_user.id)
    await _invalidate_owned_playlists_cache(current_user.id)
    stmt = select(Playlist).options(selectinload(Playlist.user)).where(Playlist.id == playlist.id)
    created = await db.scalar(stmt)
    if not created:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Playlist not found")
    return _to_playlist_out(created)


@router.get(
    "/{playlist_id:int}",
    response_model=PlaylistDetail,
    summary="Get playlist",
    description="Returns playlist and songs. (Playlist bilgisi ve sarkilarini getirir.)",
)
async def get_playlist(
    playlist_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> PlaylistDetail:
    stmt = (
        select(Playlist)
        .options(selectinload(Playlist.song_links).selectinload(PlaylistSong.song), selectinload(Playlist.user))
        .where(Playlist.id == playlist_id, Playlist.user_id == current_user.id)
    )
    playlist = await db.scalar(stmt)
    if not playlist:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Playlist not found")

    songs = [SongOut.model_validate(link.song) for link in sorted(playlist.song_links, key=lambda s: s.position)]
    return PlaylistDetail(
        id=playlist.id,
        user_id=playlist.user_id,
        owner_username=playlist.user.username if playlist.user else "unknown",
        name=playlist.name,
        description=playlist.description,
        is_public=playlist.is_public,
        created_at=playlist.created_at,
        updated_at=playlist.updated_at,
        is_followed=False,
        songs=songs,
    )


@router.put(
    "/{playlist_id:int}",
    response_model=PlaylistOut,
    summary="Update playlist",
    description="Updates playlist name or description. (Playlist adini veya aciklamasini gunceller.)",
)
async def update_playlist(
    playlist_id: int,
    payload: Annotated[PlaylistUpdate, Depends(PlaylistUpdate.as_form)],
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Playlist:
    playlist = await db.scalar(
        select(Playlist).where(Playlist.id == playlist_id, Playlist.user_id == current_user.id)
    )
    if not playlist:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Playlist not found")

    if payload.name is not None:
        playlist.name = payload.name
    if payload.description is not None:
        playlist.description = payload.description
    _touch_playlist(playlist)

    await db.commit()
    stmt = select(Playlist).options(selectinload(Playlist.user)).where(Playlist.id == playlist.id)
    updated = await db.scalar(stmt)
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Playlist not found")
    return _to_playlist_out(updated)


@router.delete(
    "/{playlist_id:int}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete playlist",
    description="Deletes playlist. (Playlisti tamamen siler.)",
)
async def delete_playlist(
    playlist_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    playlist = await db.scalar(
        select(Playlist).where(Playlist.id == playlist_id, Playlist.user_id == current_user.id)
    )
    if not playlist:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Playlist not found")

    await db.delete(playlist)
    await db.commit()
    await invalidate_user_library_summary_stats_cache(current_user.id)
    await _invalidate_owned_playlists_cache(current_user.id)
    return None


@router.post(
    "/{playlist_id:int}/songs",
    status_code=status.HTTP_201_CREATED,
    summary="Add song to playlist",
    description=(
        "Adds a song by song id or iTunes metadata fields. "
        "(Song ID veya iTunes metadata alanlari ile playliste sarki ekler.)"
    ),
)
async def add_song_to_playlist(
    playlist_id: int,
    payload: Annotated[PlaylistSongAdd, Depends(PlaylistSongAdd.as_form)],
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    playlist = await db.scalar(
        select(Playlist).where(Playlist.id == playlist_id, Playlist.user_id == current_user.id)
    )
    if not playlist:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Playlist not found")

    song: Song | None = None
    if payload.song_id:
        song = await db.scalar(select(Song).where(Song.id == payload.song_id))
    elif payload.has_track_data():
        try:
            song = await get_or_create_song_from_itunes(
                db,
                payload.to_itunes_payload(),
            )
        except IntegrityError as exc:
            await db.rollback()
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Song conflict while creating from iTunes metadata",
            ) from exc
    if not song:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Song payload is invalid")

    existing = await db.scalar(
        select(PlaylistSong).where(PlaylistSong.playlist_id == playlist.id, PlaylistSong.song_id == song.id)
    )
    if existing:
        return {"message": "Song already in playlist", "song_id": song.id}

    max_position = await db.scalar(
        select(func.max(PlaylistSong.position)).where(PlaylistSong.playlist_id == playlist.id)
    )
    next_position = 0 if max_position is None else int(max_position) + 1
    insert_position = min(payload.position, next_position)
    await db.execute(
        update(PlaylistSong)
        .where(
            PlaylistSong.playlist_id == playlist.id,
            PlaylistSong.position >= insert_position,
        )
        .values(position=PlaylistSong.position + 1)
    )
    db.add(PlaylistSong(playlist_id=playlist.id, song_id=song.id, position=insert_position))
    _touch_playlist(playlist)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        if _is_duplicate_playlist_song_error(exc):
            return {"message": "Song already in playlist", "song_id": song.id}
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to add song to playlist due to a database error",
        ) from exc
    return {"message": "Song added", "song_id": song.id}


@router.delete(
    "/{playlist_id:int}/songs/{song_id:int}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Remove song from playlist",
    description="Removes a song from playlist. (Playliste ekli sarkiyi kaldirir.)",
)
async def remove_song_from_playlist(
    playlist_id: int,
    song_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    playlist = await db.scalar(
        select(Playlist).where(Playlist.id == playlist_id, Playlist.user_id == current_user.id)
    )
    if not playlist:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Playlist not found")

    link = await db.scalar(
        select(PlaylistSong).where(PlaylistSong.playlist_id == playlist_id, PlaylistSong.song_id == song_id)
    )
    if not link:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Song not found in playlist")

    removed_position = link.position
    await db.delete(link)
    await db.execute(
        update(PlaylistSong)
        .where(
            PlaylistSong.playlist_id == playlist_id,
            PlaylistSong.position > removed_position,
        )
        .values(position=PlaylistSong.position - 1)
    )
    _touch_playlist(playlist)
    await db.commit()
    return None


@router.patch(
    "/{playlist_id:int}/songs/reorder",
    summary="Reorder songs in playlist",
    description="Updates playlist song positions based on ordered song ids.",
)
async def reorder_playlist_songs(
    playlist_id: int,
    payload: PlaylistSongReorderIn,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    stmt = (
        select(Playlist)
        .options(selectinload(Playlist.song_links))
        .where(Playlist.id == playlist_id, Playlist.user_id == current_user.id)
    )
    playlist = await db.scalar(stmt)
    if not playlist:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Playlist not found")

    existing_song_ids = [link.song_id for link in playlist.song_links]
    if sorted(existing_song_ids) != sorted(payload.song_ids):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="song_ids must include exactly the songs already in the playlist",
        )

    new_positions = {song_id: idx for idx, song_id in enumerate(payload.song_ids)}
    for link in playlist.song_links:
        link.position = new_positions[link.song_id]
    _touch_playlist(playlist)

    await db.commit()
    return {"message": "Playlist reordered", "playlist_id": playlist_id}


@router.post(
    "/{playlist_id:int}/duplicate",
    response_model=PlaylistOut,
    status_code=status.HTTP_201_CREATED,
    summary="Duplicate playlist",
    description="Creates a copy of playlist with same songs and order.",
)
async def duplicate_playlist(
    playlist_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Playlist:
    stmt = (
        select(Playlist)
        .options(selectinload(Playlist.song_links))
        .where(Playlist.id == playlist_id, Playlist.user_id == current_user.id)
    )
    source = await db.scalar(stmt)
    if not source:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Playlist not found")

    copy_name = f"{source.name} (Copy)"
    duplicated = Playlist(user_id=current_user.id, name=copy_name, description=source.description)
    db.add(duplicated)
    await db.flush()

    sorted_links = sorted(source.song_links, key=lambda link: link.position)
    for link in sorted_links:
        db.add(
            PlaylistSong(
                playlist_id=duplicated.id,
                song_id=link.song_id,
                position=link.position,
            )
        )

    await db.commit()
    await invalidate_user_library_summary_stats_cache(current_user.id)
    await _invalidate_owned_playlists_cache(current_user.id)
    stmt_with_user = select(Playlist).options(selectinload(Playlist.user)).where(Playlist.id == duplicated.id)
    new_item = await db.scalar(stmt_with_user)
    if not new_item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Playlist not found")
    return _to_playlist_out(new_item)


@router.get(
    "/discover",
    response_model=list[PlaylistOut],
    summary="Discover public playlists",
    description="Lists public playlists from all users.",
)
@cache_response("playlists_discover", ttl=40)
async def discover_public_playlists(
    q: str | None = Query(default=None, min_length=1, max_length=256),
    limit: int = Query(default=50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[PlaylistOut]:
    stmt = (
        select(Playlist)
        .options(selectinload(Playlist.user))
        .where(Playlist.is_public.is_(True))
        .order_by(Playlist.updated_at.desc())
        .limit(limit)
    )
    playlists = list((await db.execute(stmt)).scalars().all())
    if q:
        query = q.lower()
        playlists = [
            item
            for item in playlists
            if query in item.name.lower()
            or (item.description and query in item.description.lower())
            or (item.user and query in item.user.username.lower())
        ]

    follow_rows = (
        await db.execute(
            select(PlaylistFollow.playlist_id).where(
                PlaylistFollow.user_id == current_user.id,
                PlaylistFollow.playlist_id.in_([item.id for item in playlists] or [-1]),
            )
        )
    ).scalars().all()
    followed_ids = set(follow_rows)
    return [_to_playlist_out(item, is_followed=item.id in followed_ids) for item in playlists]


@router.get(
    "/{playlist_id:int}/public",
    response_model=PlaylistDetail,
    summary="Get public playlist",
    description="Returns public playlist detail for discovery/follow view.",
)
async def get_public_playlist(
    playlist_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> PlaylistDetail:
    stmt = (
        select(Playlist)
        .options(selectinload(Playlist.song_links).selectinload(PlaylistSong.song), selectinload(Playlist.user))
        .where(Playlist.id == playlist_id, Playlist.is_public.is_(True))
    )
    playlist = await db.scalar(stmt)
    if not playlist:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Public playlist not found")

    is_followed = (
        await db.scalar(
            select(PlaylistFollow).where(
                PlaylistFollow.user_id == current_user.id,
                PlaylistFollow.playlist_id == playlist.id,
            )
        )
        is not None
    )
    songs = [SongOut.model_validate(link.song) for link in sorted(playlist.song_links, key=lambda s: s.position)]
    return PlaylistDetail(
        id=playlist.id,
        user_id=playlist.user_id,
        owner_username=playlist.user.username if playlist.user else "unknown",
        name=playlist.name,
        description=playlist.description,
        is_public=playlist.is_public,
        created_at=playlist.created_at,
        updated_at=playlist.updated_at,
        is_followed=is_followed,
        songs=songs,
    )


@router.post(
    "/{playlist_id:int}/follow",
    response_model=PlaylistFollowOut,
    summary="Follow playlist",
    description="Follows a public playlist as live mirror.",
)
async def follow_playlist(
    playlist_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> PlaylistFollowOut:
    playlist = await db.scalar(select(Playlist).where(Playlist.id == playlist_id, Playlist.is_public.is_(True)))
    if not playlist:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Public playlist not found")
    if playlist.user_id == current_user.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot follow your own playlist")

    existing = await db.scalar(
        select(PlaylistFollow).where(
            PlaylistFollow.user_id == current_user.id,
            PlaylistFollow.playlist_id == playlist_id,
        )
    )
    changed = False
    if not existing:
        db.add(PlaylistFollow(user_id=current_user.id, playlist_id=playlist_id))
        try:
            await db.commit()
            changed = True
        except IntegrityError:
            await db.rollback()
    if changed:
        await _invalidate_follow_mirror_caches(current_user.id)
    return PlaylistFollowOut(playlist_id=playlist_id, followed=True)


@router.delete(
    "/{playlist_id:int}/follow",
    response_model=PlaylistFollowOut,
    summary="Unfollow playlist",
    description="Stops following a public playlist mirror.",
)
async def unfollow_playlist(
    playlist_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> PlaylistFollowOut:
    link = await db.scalar(
        select(PlaylistFollow).where(
            PlaylistFollow.user_id == current_user.id,
            PlaylistFollow.playlist_id == playlist_id,
        )
    )
    if link:
        await db.delete(link)
        await db.commit()
        await _invalidate_follow_mirror_caches(current_user.id)
    return PlaylistFollowOut(playlist_id=playlist_id, followed=False)


@router.get(
    "/following",
    response_model=list[PlaylistOut],
    summary="Following playlists",
    description="Lists playlists the current user follows.",
)
@cache_response("playlists_following", ttl=35)
async def list_following_playlists(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[PlaylistOut]:
    rows = (
        await db.execute(
            select(Playlist)
            .join(PlaylistFollow, PlaylistFollow.playlist_id == Playlist.id)
            .options(selectinload(Playlist.user))
            .where(PlaylistFollow.user_id == current_user.id)
            .order_by(Playlist.updated_at.desc())
        )
    ).scalars().all()
    return [_to_playlist_out(item, is_followed=True) for item in rows]


@router.get(
    "/following/feed",
    response_model=list[PlaylistFeedItemOut],
    summary="Following feed",
    description="Returns recently updated playlists from followed list.",
)
@cache_response("playlists_following_feed", ttl=30)
async def following_feed(
    since: datetime | None = Query(default=None),
    limit: int = Query(default=30, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[PlaylistFeedItemOut]:
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
        PlaylistFeedItemOut(
            playlist_id=item.id,
            playlist_name=item.name,
            owner_username=item.user.username if item.user else "unknown",
            updated_at=item.updated_at,
        )
        for item in items
    ]


@router.get(
    "/{playlist_id:int}/followers",
    response_model=list[PlaylistFollowerOut],
    summary="Playlist followers",
    description="Lists followers for a public playlist (or your own playlist).",
)
async def get_playlist_followers(
    playlist_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[PlaylistFollowerOut]:
    playlist = await db.scalar(select(Playlist).where(Playlist.id == playlist_id))
    if not playlist:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Playlist not found")
    if not playlist.is_public and playlist.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Playlist is private")

    rows = (
        await db.execute(
            select(User.id, User.username, PlaylistFollow.created_at)
            .join(PlaylistFollow, PlaylistFollow.user_id == User.id)
            .where(PlaylistFollow.playlist_id == playlist_id)
            .order_by(PlaylistFollow.created_at.desc())
        )
    ).all()
    return [
        PlaylistFollowerOut(user_id=int(row[0]), username=str(row[1]), followed_at=row[2])
        for row in rows
    ]


@router.get(
    "/{playlist_id:int}/stats",
    response_model=PlaylistStatsOut,
    summary="Playlist stats",
    description="Returns song/follower counters and follow status for current user.",
)
async def get_playlist_stats(
    playlist_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> PlaylistStatsOut:
    playlist = await db.scalar(select(Playlist).where(Playlist.id == playlist_id))
    if not playlist:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Playlist not found")
    if not playlist.is_public and playlist.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Playlist is private")

    song_count = int(
        (await db.scalar(select(func.count()).select_from(PlaylistSong).where(PlaylistSong.playlist_id == playlist_id)))
        or 0
    )
    follower_count = int(
        (await db.scalar(select(func.count()).select_from(PlaylistFollow).where(PlaylistFollow.playlist_id == playlist_id)))
        or 0
    )
    is_followed = (
        await db.scalar(
            select(PlaylistFollow).where(
                PlaylistFollow.playlist_id == playlist_id,
                PlaylistFollow.user_id == current_user.id,
            )
        )
        is not None
    )
    return PlaylistStatsOut(
        playlist_id=playlist_id,
        song_count=song_count,
        follower_count=follower_count,
        is_followed=is_followed,
        updated_at=playlist.updated_at,
    )


@router.patch(
    "/{playlist_id:int}/visibility",
    response_model=PlaylistOut,
    summary="Set playlist visibility",
    description="Updates public/private visibility of owned playlist.",
)
async def set_playlist_visibility(
    playlist_id: int,
    payload: PlaylistVisibilityUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> PlaylistOut:
    playlist = await db.scalar(
        select(Playlist).where(Playlist.id == playlist_id, Playlist.user_id == current_user.id)
    )
    if not playlist:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Playlist not found")
    playlist.is_public = payload.is_public
    _touch_playlist(playlist)
    await db.commit()
    stmt = select(Playlist).options(selectinload(Playlist.user)).where(Playlist.id == playlist.id)
    updated = await db.scalar(stmt)
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Playlist not found")
    return _to_playlist_out(updated)

