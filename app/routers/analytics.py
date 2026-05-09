from datetime import UTC, datetime, timedelta
import asyncio
import re
import unicodedata
from typing import Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.listening_history import ListeningHistory
from app.models.song import Song
from app.models.user import User
from app.schemas.analytics import (
    ArtistAlbumOut,
    ArtistDetailOut,
    ArtistSongOut,
    PopularArtistOut,
    TopArtistOut,
    TopGenreOut,
    TopTrackOut,
)
from app.services.itunes import itunes_service
from app.utils.cache import cache_response
from app.utils.deps import get_current_user
from app.utils.input_limits import ARTIST_QUERY_MAX
from app.utils.sql_safe import LIKE_ESCAPE_CHAR, escape_like_pattern

router = APIRouter(prefix="/analytics", tags=["analytics"])



def _start_from_days(days: int) -> datetime:
    return datetime.now(UTC) - timedelta(days=days)


def _normalize_artist(value: str | None) -> str:
    raw = (value or "").strip().lower()
    decomposed = unicodedata.normalize("NFKD", raw)
    no_diacritics = "".join(char for char in decomposed if not unicodedata.combining(char))
    compact = re.sub(r"[^a-z0-9]+", " ", no_diacritics)
    return " ".join(compact.split())

def _sort_artist_catalog_songs(songs: list[dict]) -> list[dict]:
    def _sort_key(s: dict) -> tuple[str, int, str]:
        album = str(s.get("album") or "")
        tn = int(s.get("track_number") or 0)
        title = str(s.get("title") or "")
        return (album.lower(), tn, title.lower())

    return sorted(songs, key=_sort_key)


def _pick_stable_artist_artwork(albums_raw: list[dict], songs_raw: list[dict]) -> str | None:
    album_candidates = [
        item for item in albums_raw
        if isinstance(item, dict) and str(item.get("artwork_url") or "").strip()
    ]
    if album_candidates:
        # Keep deterministic pick: earliest release date, then title.
        album_candidates.sort(
            key=lambda item: (
                str(item.get("release_date") or ""),
                str(item.get("title") or "").lower(),
            )
        )
        picked = str(album_candidates[0].get("artwork_url") or "").strip()
        if picked:
            return picked

    for song in songs_raw:
        artwork = str(song.get("artwork_url") or "").strip()
        if artwork:
            return artwork
    return None


@router.get(
    "/top-tracks",
    response_model=list[TopTrackOut],
    summary="Top tracks",
    description="Returns most played tracks for current user. (Kullanici icin en cok dinlenen sarkilari dondurur.)",
)
@cache_response("top_tracks", ttl=300)
async def top_tracks(
    limit: int = Query(default=10, ge=1, le=50, description="Maximum number of rows."),

    days: int = Query(default=30, ge=1, le=365, description="Rolling window in days."),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[TopTrackOut]:
    start_at = _start_from_days(days)
    rows = (
        await db.execute(
            select(Song.id, Song.title, Song.artist, func.count(ListeningHistory.id).label("plays"), Song.artwork_url)
            .join(ListeningHistory, ListeningHistory.song_id == Song.id)
            .where(ListeningHistory.user_id == current_user.id, ListeningHistory.listened_at >= start_at)
            .group_by(Song.id, Song.title, Song.artist, Song.artwork_url)
            .order_by(func.count(ListeningHistory.id).desc())
            .limit(limit)
        )
    ).all()
    return [TopTrackOut(song_id=int(r[0]), title=str(r[1]), artist=str(r[2]), plays=int(r[3]), artwork_url=str(r[4]) if r[4] else None) for r in rows]


@router.get(
    "/trending-tracks",
    response_model=list[TopTrackOut],
    summary="Trending tracks (community)",
    description="Most played tracks across all members in the time window. "
    "There is no minimum play count—one listen is enough. "
    "`limit` caps how many songs are returned (best-first).",
)
@cache_response("trending_tracks_v2", ttl=300)
async def trending_tracks(
    limit: int = Query(default=20, ge=1, le=50, description="Maximum number of rows."),
    days: int = Query(default=30, ge=1, le=365, description="Rolling window in days."),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[TopTrackOut]:
    """Aggregate plays from listening_history.

    Rows linked via ``song_id`` are counted via join to ``songs``. Legacy rows created by
    ``POST /history/by-itunes`` used ``song_id=NULL``; those are folded in by resolving
    ``track_itunes_id`` or ``track_title`` + ``track_artist`` to a ``Song`` row.
    """
    start_at = _start_from_days(days)
    joined_rows = (
        await db.execute(
            select(Song.id, Song.title, Song.artist, func.count(ListeningHistory.id), Song.artwork_url)
            .join(ListeningHistory, ListeningHistory.song_id == Song.id)
            .where(ListeningHistory.listened_at >= start_at)
            .group_by(Song.id, Song.title, Song.artist, Song.artwork_url)
        )
    ).all()
    plays_by_song: dict[int, dict[str, object]] = {}
    for r in joined_rows:
        sid = int(r[0])
        plays_by_song[sid] = {
            "title": str(r[1]),
            "artist": str(r[2]),
            "artwork": str(r[4]) if r[4] else None,
            "plays": int(r[3]),
        }

    orphan_rows = (
        await db.execute(
            select(
                ListeningHistory.track_itunes_id,
                ListeningHistory.track_title,
                ListeningHistory.track_artist,
                func.count(ListeningHistory.id),
            )
            .where(
                ListeningHistory.song_id.is_(None),
                ListeningHistory.listened_at >= start_at,
            )
            .group_by(
                ListeningHistory.track_itunes_id,
                ListeningHistory.track_title,
                ListeningHistory.track_artist,
            )
        )
    ).all()

    itunes_ids: set[str] = set()
    for tid, _, _, _ in orphan_rows:
        if tid and str(tid).strip():
            itunes_ids.add(str(tid).strip())

    song_by_itunes: dict[str, Song] = {}
    if itunes_ids:
        songs_m = (await db.execute(select(Song).where(Song.itunes_track_id.in_(itunes_ids)))).scalars().all()
        for s in songs_m:
            if s.itunes_track_id:
                song_by_itunes[str(s.itunes_track_id).strip()] = s

    pairs_for_batch: set[tuple[str, str]] = set()
    orphan_pass1: list[tuple[Song | None, str | None, str | None, int]] = []
    for tid, title, artist, cnt in orphan_rows:
        play_count = int(cnt)
        song: Song | None = None
        if tid and str(tid).strip():
            song = song_by_itunes.get(str(tid).strip())
        if song is None and title and artist:
            pairs_for_batch.add((title, artist))
        orphan_pass1.append((song, title, artist, play_count))

    song_by_pair: dict[tuple[str, str], Song] = {}
    if pairs_for_batch:
        pairs_list = list(pairs_for_batch)
        chunk_size = 400
        for i in range(0, len(pairs_list), chunk_size):
            chunk = pairs_list[i : i + chunk_size]
            batch = (
                await db.execute(select(Song).where(tuple_(Song.title, Song.artist).in_(chunk)))
            ).scalars().all()
            for s in batch:
                song_by_pair[(s.title, s.artist)] = s

    for song, title, artist, play_count in orphan_pass1:
        if song is None and title and artist:
            song = song_by_pair.get((title, artist))
        if song is None:
            continue
        sid = int(song.id)
        if sid in plays_by_song:
            plays_by_song[sid]["plays"] = int(plays_by_song[sid]["plays"]) + play_count
        else:
            plays_by_song[sid] = {
                "title": song.title,
                "artist": song.artist,
                "artwork": song.artwork_url,
                "plays": play_count,
            }

    ranked = sorted(plays_by_song.items(), key=lambda x: int(x[1]["plays"]), reverse=True)[:limit]
    return [
        TopTrackOut(
            song_id=sid,
            title=str(data["title"]),
            artist=str(data["artist"]),
            plays=int(data["plays"]),
            artwork_url=str(data["artwork"]) if data.get("artwork") else None,
        )
        for sid, data in ranked
    ]


@router.get(
    "/top-artists",
    response_model=list[TopArtistOut],
    summary="Top artists",
    description="Returns most played artists for current user. (Kullanici icin en cok dinlenen sanatcilari dondurur.)",
)
@cache_response("top_artists", ttl=300)
async def top_artists(
    limit: int = Query(default=10, ge=1, le=50, description="Maximum number of rows."),

    days: int = Query(default=30, ge=1, le=365, description="Rolling window in days."),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[TopArtistOut]:
    start_at = _start_from_days(days)
    top_artists_subquery = (
        select(Song.artist.label("artist"), func.count(ListeningHistory.id).label("plays"))
        .join(ListeningHistory, ListeningHistory.song_id == Song.id)
        .where(ListeningHistory.user_id == current_user.id, ListeningHistory.listened_at >= start_at)
        .group_by(Song.artist)
        .subquery()
    )

    latest_artwork_subquery = (
        select(Song.artwork_url)
        .join(ListeningHistory, ListeningHistory.song_id == Song.id)
        .where(
            ListeningHistory.user_id == current_user.id,
            ListeningHistory.listened_at >= start_at,
            Song.artist == top_artists_subquery.c.artist,
            Song.artwork_url.is_not(None),
        )
        .order_by(ListeningHistory.listened_at.desc())
        .limit(1)
        .scalar_subquery()
    )

    rows = (
        await db.execute(
            select(
                top_artists_subquery.c.artist,
                top_artists_subquery.c.plays,
                latest_artwork_subquery.label("artwork_url"),
            )
            .order_by(top_artists_subquery.c.plays.desc())
            .limit(limit)
        )
    ).all()
    return [
        TopArtistOut(
            artist=str(r[0]),
            plays=int(r[1]),
            artwork_url=str(r[2]) if r[2] else None,
        )
        for r in rows
    ]


@router.get(
    "/top-genres",
    response_model=list[TopGenreOut],
    summary="Top genres",
    description="Returns most played genres for current user. (Kullanici icin en cok dinlenen turleri dondurur.)",
)
@cache_response("top_genres", ttl=300)
async def top_genres(
    limit: int = Query(default=10, ge=1, le=50, description="Maximum number of rows."),

    days: int = Query(default=30, ge=1, le=365, description="Rolling window in days."),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[TopGenreOut]:
    start_at = _start_from_days(days)
    rows = (
        await db.execute(
            select(Song.genre, func.count(ListeningHistory.id).label("plays"))
            .join(ListeningHistory, ListeningHistory.song_id == Song.id)
            .where(
                ListeningHistory.user_id == current_user.id,
                ListeningHistory.listened_at >= start_at,
                Song.genre.is_not(None),
            )
            .group_by(Song.genre)
            .order_by(func.count(ListeningHistory.id).desc())
            .limit(limit)
        )
    ).all()
    return [TopGenreOut(genre=str(r[0]), plays=int(r[1])) for r in rows if r[0]]


@router.get(
    "/top-tracks-by-genre",
    response_model=list[TopTrackOut],
    summary="Top tracks by genre",
    description=(
        "Returns most played tracks for current user filtered by a specific genre. "
        "(Kullanici icin secilen ture gore en cok dinlenen sarkilari dondurur.)"
    ),
)
async def top_tracks_by_genre(
    genre: str = Query(min_length=1, max_length=128, description="Genre filter."),
    limit: int = Query(default=10, ge=1, le=50, description="Maximum number of rows."),
    days: int = Query(default=30, ge=1, le=365, description="Rolling window in days."),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[TopTrackOut]:
    genre_value = genre.strip()
    if not genre_value:
        return []
    start_at = _start_from_days(days)
    rows = (
        await db.execute(
            select(Song.id, Song.title, Song.artist, func.count(ListeningHistory.id).label("plays"), Song.artwork_url)
            .join(ListeningHistory, ListeningHistory.song_id == Song.id)
            .where(
                ListeningHistory.user_id == current_user.id,
                ListeningHistory.listened_at >= start_at,
                Song.genre.is_not(None),
                Song.genre.ilike(escape_like_pattern(genre_value), escape=LIKE_ESCAPE_CHAR),
            )
            .group_by(Song.id, Song.title, Song.artist, Song.artwork_url)
            .order_by(func.count(ListeningHistory.id).desc())
            .limit(limit)
        )
    ).all()
    return [TopTrackOut(song_id=int(r[0]), title=str(r[1]), artist=str(r[2]), plays=int(r[3]), artwork_url=str(r[4]) if r[4] else None) for r in rows]


@router.get(
    "/popular-artists",
    response_model=list[PopularArtistOut],
    summary="Popular artists rail",
    description=(
        "Returns personalized + Turkey trending artists for the search rail. "
        "(Arama sanatci rail'i icin kisisel + Turkiye trend sanatcilari dondurur.)"
    ),
)
@cache_response("popular_artists", ttl=600)
async def popular_artists(
    limit: int = Query(default=40, ge=15, le=50, description="Maximum number of artists."),

    days: int = Query(default=30, ge=1, le=365, description="Rolling window in days for personal ranking."),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[PopularArtistOut]:
    start_at = _start_from_days(days)
    personal_limit = limit
    top_artists_subquery = (
        select(Song.artist.label("artist"), func.count(ListeningHistory.id).label("plays"))
        .join(ListeningHistory, ListeningHistory.song_id == Song.id)
        .where(ListeningHistory.user_id == current_user.id, ListeningHistory.listened_at >= start_at)
        .group_by(Song.artist)
        .subquery()
    )
    latest_artwork_subquery = (
        select(Song.artwork_url)
        .join(ListeningHistory, ListeningHistory.song_id == Song.id)
        .where(
            ListeningHistory.user_id == current_user.id,
            ListeningHistory.listened_at >= start_at,
            Song.artist == top_artists_subquery.c.artist,
            Song.artwork_url.is_not(None),
        )
        .order_by(ListeningHistory.listened_at.desc())
        .limit(1)
        .scalar_subquery()
    )
    personal_rows = (
        await db.execute(
            select(
                top_artists_subquery.c.artist,
                top_artists_subquery.c.plays,
                latest_artwork_subquery.label("artwork_url"),
            )
            .order_by(top_artists_subquery.c.plays.desc())
            .limit(personal_limit)
        )
    ).all()

    merged: list[PopularArtistOut] = []
    seen_keys: set[str] = set()
    for row in personal_rows:
        artist_name = str(row[0]).strip()
        if not artist_name:
            continue
        artist_key = _normalize_artist(artist_name)
        if not artist_key or artist_key in seen_keys:
            continue
        seen_keys.add(artist_key)
        merged.append(
            PopularArtistOut(
                artist=artist_name,
                artwork_url=str(row[2]) if row[2] else None,
                source="personal",
                score=int(row[1]),
                reason="Because you listened",
            )
        )
        if len(merged) >= limit:
            return merged[:limit]

    try:
        trending_artists = await itunes_service.get_trending_artists_tr(limit=limit * 2)
    except Exception:
        trending_artists = []
    for item in trending_artists:
        artist_name = str(item.get("artist") or "").strip()
        if not artist_name:
            continue
        artist_key = _normalize_artist(artist_name)
        if not artist_key or artist_key in seen_keys:
            continue
        seen_keys.add(artist_key)
        merged.append(
            PopularArtistOut(
                artist=artist_name,
                artwork_url=item.get("artwork_url"),
                source="trending",
                score=None,
                reason="Trending in Turkiye",
            )
        )
        if len(merged) >= limit:
            break
    return merged[:limit]


@router.get(
    "/artist-detail",
    response_model=ArtistDetailOut,
    summary="Artist detail songs",
    description="Returns iTunes songs for an artist. (Bir sanatci icin iTunes sarkilarini dondurur.)",
)
@cache_response("artist_detail_v2", ttl=600)
async def artist_detail(
    artist: str = Query(min_length=1, max_length=ARTIST_QUERY_MAX, description="Artist name."),

    songs_limit: int = Query(
        default=10_000,
        ge=1,
        le=10_000,
        description="Max songs to return (catalog is built from iTunes lookup + all albums).",
    ),
    catalog_depth: Literal["fast", "full"] = Query(
        default="full",
        description="fast: one iTunes lookup (~200 songs max), no album crawl. full: merged catalog.",
    ),
    _: object = Depends(get_current_user),
) -> ArtistDetailOut:
    artist_name = artist.strip()
    if not artist_name:
        return ArtistDetailOut(
            artist="Unknown",
            artist_id=None,
            songs=[],
            songs_limit=songs_limit,
            total_songs_available=0,
            has_more=False,
            source="fallback",
            catalog_complete=True,
        )
    try:
        artist_item = await itunes_service.get_artist_by_name_tr(artist_name)
        if not artist_item or not artist_item.get("artistId"):
            return ArtistDetailOut(
                artist=artist_name,
                artist_id=None,
                songs=[],
                songs_limit=songs_limit,
                total_songs_available=0,
                has_more=False,
                source="fallback",
                catalog_complete=True,
            )
        artist_id = int(artist_item["artistId"])
        display_artist = str(artist_item.get("artistName") or artist_name)

        if catalog_depth == "fast":
            songs_quick = await itunes_service.get_artist_songs(artist_id, limit=200)
            songs_sorted = _sort_artist_catalog_songs(songs_quick)
            total_quick = len(songs_sorted)
            limited_raw = songs_sorted[:songs_limit]
            stable_artwork = _pick_stable_artist_artwork([], songs_sorted)
            limited_songs = [ArtistSongOut(**song) for song in limited_raw]
            has_more = (len(limited_songs) < total_quick) or (total_quick >= 200)
            return ArtistDetailOut(
                artist=display_artist,
                artist_id=artist_id,
                artist_artwork_url=stable_artwork,
                songs=limited_songs,
                songs_limit=songs_limit,
                total_songs_available=total_quick,
                has_more=has_more,
                source="itunes",
                catalog_complete=False,
            )

        all_songs_raw, all_albums_raw = await itunes_service.get_artist_catalog(artist_id)
        stable_artwork = _pick_stable_artist_artwork(all_albums_raw, all_songs_raw)
        total_available = len(all_songs_raw)
        limited_songs = [ArtistSongOut(**song) for song in all_songs_raw[:songs_limit]]
        return ArtistDetailOut(
            artist=display_artist,
            artist_id=artist_id,
            artist_artwork_url=stable_artwork,
            songs=limited_songs,
            songs_limit=songs_limit,
            total_songs_available=total_available,
            has_more=total_available > len(limited_songs),
            source="itunes",
            catalog_complete=True,
        )
    except Exception:
        return ArtistDetailOut(
            artist=artist_name,
            artist_id=None,
            songs=[],
            songs_limit=songs_limit,
            total_songs_available=0,
            has_more=False,
            source="fallback",
            catalog_complete=True,
        )


@router.get(
    "/artist-albums",
    response_model=list[ArtistAlbumOut],
    summary="Artist albums",
    description="Returns iTunes albums for an artist. (Bir sanatci icin iTunes albumlerini dondurur.)",
)
async def artist_albums(
    artist: str = Query(min_length=1, max_length=ARTIST_QUERY_MAX, description="Artist name."),
    limit: int = Query(default=100, ge=1, le=200, description="Maximum album count."),
    _: object = Depends(get_current_user),
) -> list[ArtistAlbumOut]:
    artist_name = artist.strip()
    if not artist_name:
        return []
    try:
        artist_item = await itunes_service.get_artist_by_name_tr(artist_name)
        if not artist_item or not artist_item.get("artistId"):
            return []
        artist_id = int(artist_item["artistId"])
        albums_raw = await itunes_service.get_artist_albums(artist_id=artist_id, limit=limit)
        return [ArtistAlbumOut(**album) for album in albums_raw]
    except Exception:
        return []


@router.get(
    "/album-tracks",
    response_model=list[ArtistSongOut],
    summary="Album tracks",
    description="Returns tracks of an iTunes album. (Bir iTunes albumunun sarkilarini dondurur.)",
)
async def album_tracks(
    collection_id: int = Query(ge=1, description="iTunes collection id."),
    limit: int = Query(default=200, ge=1, le=200, description="Maximum track count."),
    _: object = Depends(get_current_user),
) -> list[ArtistSongOut]:
    try:
        tracks_raw = await itunes_service.get_album_tracks(collection_id=collection_id, limit=limit)
        return [ArtistSongOut(**track) for track in tracks_raw]
    except Exception:
        return []
