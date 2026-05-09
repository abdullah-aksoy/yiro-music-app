from datetime import UTC, datetime, timedelta

from sqlalchemy import Select, and_, desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.models.favorite import Favorite
from app.models.listening_history import ListeningHistory
from app.models.song import Song

# Bound co-occurrence scans to recent history (avoids full-table joins).
_RECOMMEND_COOC_WINDOW_DAYS = 120


async def recommend_for_user(db: AsyncSession, user_id: int, limit: int = 10) -> list[Song]:
    genre_stmt: Select[tuple[str, int]] = (
        select(Song.genre, func.count(ListeningHistory.id))
        .join(ListeningHistory, ListeningHistory.song_id == Song.id)
        .where(ListeningHistory.user_id == user_id, Song.genre.is_not(None))
        .group_by(Song.genre)
        .order_by(func.count(ListeningHistory.id).desc())
    )
    top_genres = [row[0] for row in (await db.execute(genre_stmt)).all() if row[0]]

    interacted_stmt = (
        select(Favorite.song_id)
        .where(Favorite.user_id == user_id)
        .union(select(ListeningHistory.song_id).where(ListeningHistory.user_id == user_id))
    )
    interacted_song_ids = {
        song_id for song_id in (await db.execute(interacted_stmt)).scalars().all() if song_id is not None
    }

    if top_genres:
        genre_based_stmt = select(Song).where(Song.genre.in_(top_genres))
        if interacted_song_ids:
            genre_based_stmt = genre_based_stmt.where(Song.id.not_in(interacted_song_ids))
        genre_based_stmt = genre_based_stmt.limit(limit)
        songs = (await db.execute(genre_based_stmt)).scalars().all()
        if songs:
            return list(songs)

    since = datetime.now(UTC) - timedelta(days=_RECOMMEND_COOC_WINDOW_DAYS)
    Me = aliased(ListeningHistory)
    Peer = aliased(ListeningHistory)
    cooc_stmt = (
        select(Peer.song_id, func.count(func.distinct(Peer.user_id)).label("peer_cnt"))
        .select_from(Me)
        .join(
            Peer,
            and_(
                Peer.song_id == Me.song_id,
                Peer.user_id != Me.user_id,
                Me.user_id == user_id,
            ),
        )
        .where(
            Me.song_id.is_not(None),
            Peer.song_id.is_not(None),
            Me.listened_at >= since,
            Peer.listened_at >= since,
        )
    )
    if interacted_song_ids:
        cooc_stmt = cooc_stmt.where(Peer.song_id.not_in(interacted_song_ids))

    cooc_stmt = cooc_stmt.group_by(Peer.song_id).order_by(desc("peer_cnt"), Peer.song_id).limit(limit)
    rows = (await db.execute(cooc_stmt)).all()
    if not rows:
        return []

    song_ids = [int(r[0]) for r in rows if r[0] is not None]
    if not song_ids:
        return []

    songs_result = await db.execute(select(Song).where(Song.id.in_(song_ids)))
    songs_by_id = {s.id: s for s in songs_result.scalars().all()}
    return [songs_by_id[sid] for sid in song_ids if sid in songs_by_id]
