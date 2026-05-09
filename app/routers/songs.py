from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse
from sqlalchemy import inspect as sa_inspect
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.favorite import Favorite
from app.models.playlist import Playlist, PlaylistSong
from app.models.song import Song
from app.models.user import User
from app.schemas.song import (
    ITunesTrackIn,
    SongCreate,
    SongOut,
    SongRelationPlaylistOut,
    SongRelationsBatchIn,
    SongRelationsOut,
)
from app.services.audio import get_music_root, validate_local_file_path
from app.services.song_store import backfill_song_artwork_if_missing, get_or_create_song_from_itunes
from app.utils.deps import get_current_user, get_current_user_from_bearer_or_query
from app.utils.input_limits import LOCAL_FILE_PATH_MAX, SONG_RELATIONS_BATCH_MAX

router = APIRouter(prefix="/songs", tags=["songs"])


@router.get(
    "",
    response_model=list[SongOut],
    summary="List songs",
    description="Returns songs with pagination. (Sarkilari sayfalama ile listeler.)",
)
async def list_songs(
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    _: object = Depends(get_current_user),
) -> list[Song]:
    stmt = select(Song).order_by(Song.created_at.desc()).offset(skip).limit(limit)
    return list((await db.execute(stmt)).scalars().all())


@router.get(
    "/artwork",
    summary="Get local artwork by path",
    description="Serves local artwork files under configured music directory. "
    "Use Authorization: Bearer or ?token= (same as streaming) because browsers do not send headers on <img>.",
)
async def get_local_artwork(
    path: str = Query(min_length=1, max_length=LOCAL_FILE_PATH_MAX),
    _: object = Depends(get_current_user_from_bearer_or_query),
) -> FileResponse:
    normalized = path.strip().replace("\\", "/")
    music_root = get_music_root().resolve()
    candidate = Path(normalized)
    if candidate.is_absolute():
        resolved = candidate.resolve()
    else:
        resolved = (music_root / candidate).resolve()
    if music_root not in resolved.parents and resolved != music_root:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid artwork path")
    if not resolved.exists() or not resolved.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Artwork file not found")
    return FileResponse(resolved)


@router.post(
    "/by-itunes",
    response_model=SongOut,
    status_code=status.HTTP_200_OK,
    summary="Get or create song from iTunes fields",
    description="Returns an existing song or creates a new one from iTunes metadata. (iTunes verilerinden sarki dondurur veya olusturur.)",
)
async def get_or_create_song_from_itunes_route(
    payload: Annotated[ITunesTrackIn, Depends(ITunesTrackIn.as_form)],
    db: AsyncSession = Depends(get_db),
    _: object = Depends(get_current_user),
) -> Song:
    if not payload.has_track_data():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="iTunes payload is required",
        )
    try:
        song = await get_or_create_song_from_itunes(db, payload.to_itunes_payload())
        await db.commit()
        await db.refresh(song)
        return song
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Song conflict while processing iTunes metadata",
        ) from exc


@router.post(
    "/relations/batch",
    response_model=list[SongRelationsOut],
    summary="Batch song relations",
    description="Returns favorite and playlist relations for many songs in one query.",
)
async def get_song_relations_batch(
    payload: SongRelationsBatchIn,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[SongRelationsOut]:
    seen: list[int] = []
    for sid in payload.song_ids:
        if sid not in seen:
            seen.append(sid)
        if len(seen) >= SONG_RELATIONS_BATCH_MAX:
            break
    if not seen:
        return []

    existing_rows = list((await db.execute(select(Song.id).where(Song.id.in_(seen)))).scalars().all())
    existing_set = set(existing_rows)
    if not existing_set:
        return []

    fav_rows = (
        await db.execute(
            select(Favorite.song_id).where(
                Favorite.user_id == current_user.id,
                Favorite.song_id.in_(existing_set),
            )
        )
    ).all()
    favorited_ids = {row[0] for row in fav_rows}

    pl_rows = (
        await db.execute(
            select(PlaylistSong.song_id, Playlist.id, Playlist.name)
            .join(Playlist, PlaylistSong.playlist_id == Playlist.id)
            .where(Playlist.user_id == current_user.id, PlaylistSong.song_id.in_(existing_set))
            .order_by(Playlist.name.asc())
        )
    ).all()

    playlists_by_song: dict[int, list[SongRelationPlaylistOut]] = {}
    for song_id, pl_id, pl_name in pl_rows:
        playlists_by_song.setdefault(song_id, []).append(SongRelationPlaylistOut(id=pl_id, name=pl_name))

    out: list[SongRelationsOut] = []
    for sid in seen:
        if sid not in existing_set:
            continue
        out.append(
            SongRelationsOut(
                song_id=sid,
                favorited=sid in favorited_ids,
                playlists=playlists_by_song.get(sid, []),
            )
        )
    return out


@router.get(
    "/{song_id}",
    response_model=SongOut,
    summary="Get song",
    description="Returns one song by id. (ID ile tek sarkinin bilgilerini getirir.)",
)
async def get_song(song_id: int, db: AsyncSession = Depends(get_db), _: object = Depends(get_current_user)) -> Song:
    song = await db.scalar(select(Song).where(Song.id == song_id))
    if not song:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Song not found")
    await backfill_song_artwork_if_missing(db, song)
    if sa_inspect(song).modified:
        await db.commit()
        await db.refresh(song)
    return song


@router.post(
    "",
    response_model=SongOut,
    status_code=status.HTTP_201_CREATED,
    summary="Create song",
    description="Creates a new song record. (Yeni sarki kaydi olusturur.)",
)
async def create_song(
    payload: Annotated[SongCreate, Depends(SongCreate.as_form)],
    db: AsyncSession = Depends(get_db),
    _: object = Depends(get_current_user),
) -> Song:
    data = payload.model_dump()
    if payload.is_local:
        try:
            data["file_path"] = validate_local_file_path(payload.file_path)
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    else:
        data["file_path"] = None
    song = Song(**data)
    db.add(song)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Song already exists with this iTunes track id",
        ) from exc
    await db.refresh(song)
    return song


@router.get(
    "/{song_id}/relations",
    response_model=SongRelationsOut,
    summary="Get song relations",
    description="Returns favorite and playlist relations for current user.",
)
async def get_song_relations(
    song_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> SongRelationsOut:
    song = await db.scalar(select(Song).where(Song.id == song_id))
    if not song:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Song not found")

    favorite = await db.scalar(
        select(Favorite).where(Favorite.user_id == current_user.id, Favorite.song_id == song_id)
    )
    playlist_rows = (
        await db.execute(
            select(Playlist.id, Playlist.name)
            .join(PlaylistSong, PlaylistSong.playlist_id == Playlist.id)
            .where(Playlist.user_id == current_user.id, PlaylistSong.song_id == song_id)
            .order_by(Playlist.name.asc())
        )
    ).all()

    return SongRelationsOut(
        song_id=song_id,
        favorited=favorite is not None,
        playlists=[SongRelationPlaylistOut(id=row[0], name=row[1]) for row in playlist_rows],
    )

