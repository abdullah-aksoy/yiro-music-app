import asyncio
import logging
import re
import unicodedata

import httpx
from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import get_db
from app.models.song import Song
from app.schemas.search import SearchResult, SearchSong
from app.services.itunes import itunes_service, upgrade_itunes_artwork_url
from app.utils.deps import get_current_user
from app.utils.redis_client import RedisClient
from app.utils.sql_safe import ilike_contains

router = APIRouter(prefix="/search", tags=["search"])
settings = get_settings()
logger = logging.getLogger(__name__)


def _normalize_text(value: str | None) -> str:
    raw = (value or "").strip().lower()
    decomposed = unicodedata.normalize("NFKD", raw)
    no_diacritics = "".join(char for char in decomposed if not unicodedata.combining(char))
    compact = re.sub(r"[^a-z0-9]+", " ", no_diacritics)
    return " ".join(compact.split())


def _search_cache_key(q: str) -> str:
    norm = _normalize_text(q) or q.strip().lower()
    return f"cache:search:v1:{norm}"[:512]


def _song_keys(*, itunes_track_id: str | None, title: str | None, artist: str | None) -> set[str]:
    keys: set[str] = set()
    if itunes_track_id:
        keys.add(f"itunes:{itunes_track_id.strip().lower()}")
    normalized_title = _normalize_text(title)
    normalized_artist = _normalize_text(artist)
    if normalized_title and normalized_artist:
        keys.add(f"title_artist:{normalized_title}:{normalized_artist}")
    return keys


def _is_unknown_artist(value: str | None) -> bool:
    return _normalize_text(value) in {"", "unknown"}


@router.get(
    "",
    response_model=SearchResult,
    summary="Search songs",
    description=(
        "Returns local and iTunes search results together with local-first ordering. "
        "(Lokal ve iTunes sonuclarini birlikte dondurur; lokal sonuclar once gelir.)"
    ),
)
async def search_song(
    q: str = Query(min_length=1, max_length=256),
    db: AsyncSession = Depends(get_db),
    _: object = Depends(get_current_user),
) -> SearchResult:
    q_clean = q.strip()
    if not q_clean:
        return SearchResult(source="empty", songs=[])

    redis = RedisClient.get_client()
    cache_key = _search_cache_key(q_clean)
    if redis and settings.search_redis_ttl_seconds > 0:
        try:
            cached = await redis.get(cache_key)
            if cached:
                return SearchResult.model_validate_json(cached)
        except Exception as exc:
            logger.debug("search cache read failed: %s", exc)

    async def fetch_itunes() -> tuple[list[dict], bool]:
        try:
            results = await itunes_service.search_songs(term=q_clean, limit=20)
            return results, True
        except httpx.HTTPError:
            return [], False

    itunes_task = asyncio.create_task(fetch_itunes())

    stmt = (
        select(Song)
        .where(or_(ilike_contains(Song.title, q_clean), ilike_contains(Song.artist, q_clean)))
        .order_by(Song.created_at.desc())
        .limit(20)
    )
    local_songs = list((await db.execute(stmt)).scalars().all())
    itunes_results, itunes_available = await itunes_task

    local_payload = [
        SearchSong(
            id=s.id,
            title=s.title,
            artist=s.artist,
            album=s.album,
            genre=s.genre,
            duration_ms=s.duration_ms,
            artwork_url=upgrade_itunes_artwork_url(s.artwork_url),
            preview_url=s.preview_url,
            file_path=s.file_path,
            itunes_track_id=s.itunes_track_id,
            is_local=s.is_local,
            created_at=s.created_at,
        )
        for s in local_songs
    ]
    itunes_payload = [
        SearchSong(
            title=item.get("trackName") or item.get("collectionName") or "Unknown",
            artist=item.get("artistName") or "Unknown",
            album=item.get("collectionName"),
            genre=item.get("primaryGenreName"),
            duration_ms=item.get("trackTimeMillis"),
            artwork_url=upgrade_itunes_artwork_url(item.get("artworkUrl100") or item.get("artworkUrl60")),
            preview_url=item.get("previewUrl"),
            itunes_track_id=str(item.get("trackId")) if item.get("trackId") else None,
            is_local=False,
        )
        for item in itunes_results
    ]

    local_unknown_artist_titles = {
        _normalize_text(song.title)
        for song in local_payload
        if _normalize_text(song.title) and _is_unknown_artist(song.artist)
    }
    seen_keys: set[str] = set()
    merged_songs: list[SearchSong] = []
    for song in local_payload + itunes_payload:
        if not song.is_local and _normalize_text(song.title) in local_unknown_artist_titles:
            continue
        keys = _song_keys(
            itunes_track_id=song.itunes_track_id,
            title=song.title,
            artist=song.artist,
        )
        if keys & seen_keys:
            continue
        seen_keys.update(keys)
        merged_songs.append(song)

    if local_payload and itunes_payload:
        source = "mixed"
    elif local_payload and not itunes_payload:
        source = "local_only" if itunes_available else "itunes_unavailable"
    elif itunes_payload:
        source = "itunes_only"
    else:
        source = "itunes_unavailable" if not itunes_available else "empty"

    result = SearchResult(source=source, songs=merged_songs)

    if redis and settings.search_redis_ttl_seconds > 0:
        try:
            await redis.setex(cache_key, settings.search_redis_ttl_seconds, result.model_dump_json())
        except Exception as exc:
            logger.debug("search cache write failed: %s", exc)

    return result
