from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.song import Song
from app.services.itunes import itunes_service, upgrade_itunes_artwork_url


async def _enrich_itunes_payload_from_lookup(payload: dict) -> None:
    """Fill artwork/preview/metadata when only trackId (+ optional title/artist) was provided."""
    tid = payload.get("trackId")
    if tid is None:
        return
    if payload.get("artworkUrl100") or payload.get("artworkUrl60"):
        return
    try:
        track_id_int = int(tid)
    except (TypeError, ValueError):
        return
    item = await itunes_service.lookup_song_track(track_id_int)
    if not item:
        return
    payload.setdefault("trackName", item.get("trackName"))
    payload.setdefault("artistName", item.get("artistName"))
    payload.setdefault("collectionName", item.get("collectionName"))
    payload.setdefault("primaryGenreName", item.get("primaryGenreName"))
    payload.setdefault("trackTimeMillis", item.get("trackTimeMillis"))
    art = upgrade_itunes_artwork_url(item.get("artworkUrl100") or item.get("artworkUrl60"))
    if art:
        payload["artworkUrl100"] = art
    if item.get("previewUrl") and not payload.get("previewUrl"):
        payload["previewUrl"] = item.get("previewUrl")


async def backfill_song_artwork_if_missing(db: AsyncSession, song: Song) -> None:
    """If song has iTunes id but no cover, fetch from iTunes lookup (e.g. legacy rows from discover)."""
    if not song.itunes_track_id or (song.artwork_url or "").strip():
        return
    try:
        tid = int(song.itunes_track_id)
    except (TypeError, ValueError):
        return
    await _backfill_song_artwork_from_itunes(db, song, tid)


async def _backfill_song_artwork_from_itunes(db: AsyncSession, song: Song, track_id: int) -> None:
    if song.artwork_url and str(song.artwork_url).strip():
        return
    item = await itunes_service.lookup_song_track(track_id)
    if not item:
        return
    art = upgrade_itunes_artwork_url(item.get("artworkUrl100") or item.get("artworkUrl60"))
    if art:
        song.artwork_url = art
    if item.get("previewUrl") and not (song.preview_url or "").strip():
        song.preview_url = item.get("previewUrl")
    if item.get("trackTimeMillis") is not None and song.duration_ms is None:
        song.duration_ms = int(item["trackTimeMillis"])


async def get_or_create_song_from_itunes(db: AsyncSession, payload: dict) -> Song:
    await _enrich_itunes_payload_from_lookup(payload)
    track_id = payload.get("trackId")
    if track_id:
        existing = await db.scalar(select(Song).where(Song.itunes_track_id == str(track_id)))
        if existing:
            try:
                tid_int = int(track_id)
            except (TypeError, ValueError):
                tid_int = None
            if tid_int is not None:
                await _backfill_song_artwork_from_itunes(db, existing, tid_int)
            return existing
    else:
        title = payload.get("trackName") or payload.get("collectionName")
        artist = payload.get("artistName")
        if title and artist:
            existing = await db.scalar(select(Song).where(Song.title == title, Song.artist == artist))
            if existing:
                if existing.itunes_track_id:
                    try:
                        await _backfill_song_artwork_from_itunes(db, existing, int(existing.itunes_track_id))
                    except (TypeError, ValueError):
                        pass
                return existing

    song = Song(
        title=payload.get("trackName") or payload.get("collectionName") or "Unknown",
        artist=payload.get("artistName") or "Unknown",
        album=payload.get("collectionName"),
        genre=payload.get("primaryGenreName"),
        duration_ms=payload.get("trackTimeMillis"),
        artwork_url=upgrade_itunes_artwork_url(payload.get("artworkUrl100") or payload.get("artworkUrl60")),
        preview_url=payload.get("previewUrl"),
        itunes_track_id=str(track_id) if track_id else None,
        is_local=False,
    )
    try:
        async with db.begin_nested():
            db.add(song)
            await db.flush()
        return song
    except IntegrityError:
        if track_id:
            existing = await db.scalar(select(Song).where(Song.itunes_track_id == str(track_id)))
            if existing:
                try:
                    await _backfill_song_artwork_from_itunes(db, existing, int(track_id))
                except (TypeError, ValueError):
                    pass
                return existing

        title = payload.get("trackName") or payload.get("collectionName")
        artist = payload.get("artistName")
        if title and artist:
            existing = await db.scalar(select(Song).where(Song.title == title, Song.artist == artist))
            if existing:
                if existing.itunes_track_id:
                    try:
                        await _backfill_song_artwork_from_itunes(db, existing, int(existing.itunes_track_id))
                    except (TypeError, ValueError):
                        pass
                return existing
        raise

