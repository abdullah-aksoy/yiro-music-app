import logging
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Path, Query, status

from sqlalchemy import func, select, update


from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import SessionLocal, get_db
from app.models.discover import DiscoverSample, DiscoverSampleComment, DiscoverSampleLike, DiscoverSampleSave
from app.models.song import Song
from app.models.user import User
from app.schemas.discover import (
    DiscoverCommentCreate,
    DiscoverCommentOut,
    DiscoverSampleOut,
    DiscoverToggleState,
    DiscoverVideoForSongOut,
)
from app.schemas.song import ITunesTrackIn
from app.services.discover_clips import (
    clip_video_url,
    discover_clips_file_exists,
    load_discover_clip_catalog,
)
from app.services.itunes import itunes_service
from app.services.song_store import get_or_create_song_from_itunes
from app.utils.deps import get_current_user
from app.utils.safe_media_url import is_safe_sticker_url

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/discover", tags=["discover"])


async def _discover_sample_reference_exists(db: AsyncSession, sample_id: int) -> bool:
    if await db.get(DiscoverSample, sample_id) is not None:
        return True
    if discover_clips_file_exists():
        return any(int(c["id"]) == sample_id for c in load_discover_clip_catalog())
    return False


async def _ensure_discover_sample_row(db: AsyncSession, sample_id: int) -> DiscoverSample | None:
    """Catalog-driven clips may exist only in JSON until first like/save/comment; create DB row."""
    row = await db.get(DiscoverSample, sample_id)
    if row:
        return row
    if not discover_clips_file_exists():
        return None
    catalog = load_discover_clip_catalog()
    c = next((x for x in catalog if int(x["id"]) == sample_id), None)
    if not c:
        return None
    settings = get_settings()
    try:
        video_url = clip_video_url(settings, str(c["file"]))
    except ValueError:
        return None
    tid = c.get("itunes_track_id")
    itunes_val: int | None
    try:
        itunes_val = int(tid) if tid is not None else None
    except (TypeError, ValueError):
        itunes_val = None
    row = DiscoverSample(
        id=sample_id,
        artist_name=str(c["artist_name"]),
        title=str(c["title"]),
        video_url=video_url,
        itunes_track_id=itunes_val,
        sort_order=int(c.get("sort_order", 0)),
    )
    db.add(row)
    try:
        await db.commit()
        await db.refresh(row)
        return row
    except IntegrityError:
        await db.rollback()
        return await db.get(DiscoverSample, sample_id)


async def _resolve_missing_itunes(db: AsyncSession, samples: list[DiscoverSample]) -> None:
    changed = False
    for s in samples:
        if s.itunes_track_id is not None:
            continue
        term = f"{s.artist_name} {s.title}"
        try:
            hits = await itunes_service.search_songs(term, limit=5)
        except Exception as exc:
            logger.debug("iTunes resolve skip sample_id=%s: %s", s.id, exc)
            continue
        for h in hits:
            tid = h.get("trackId")
            if tid:
                await db.execute(
                    update(DiscoverSample).where(DiscoverSample.id == s.id).values(itunes_track_id=int(tid))
                )
                s.itunes_track_id = int(tid)
                changed = True
                break
    if changed:
        await db.commit()


async def _ensure_discover_song_ids(db: AsyncSession, samples: list[DiscoverSample]) -> None:
    """Create/link canonical Song rows and set discover_samples.song_id (stable play + search mapping)."""
    changed = False
    for s in samples:
        if s.song_id is not None:
            continue
        if s.itunes_track_id is None:
            continue
        payload = ITunesTrackIn(
            itunes_track_id=str(int(s.itunes_track_id)),
            title=s.title,
            artist=s.artist_name,
        ).to_itunes_payload()
        song = await get_or_create_song_from_itunes(db, payload)
        await db.execute(update(DiscoverSample).where(DiscoverSample.id == s.id).values(song_id=song.id))
        s.song_id = song.id
        changed = True
    if changed:
        await db.commit()


async def _apply_catalog_itunes_to_db(db: AsyncSession, rows: list[DiscoverSample]) -> None:
    """discover-clips.json içindeki itunes_track_id değerlerini DB'ye yaz (iTunes API atlanır)."""
    if not discover_clips_file_exists():
        return
    jmap: dict[int, int] = {}
    for c in load_discover_clip_catalog():
        tid = c.get("itunes_track_id")
        if tid is None:
            continue
        try:
            jmap[int(c["id"])] = int(tid)
        except (TypeError, ValueError, KeyError):
            continue
    changed = False
    for s in rows:
        if s.itunes_track_id is not None:
            continue
        tid = jmap.get(s.id)
        if tid is None:
            continue
        await db.execute(update(DiscoverSample).where(DiscoverSample.id == s.id).values(itunes_track_id=tid))
        s.itunes_track_id = tid
        changed = True
    if changed:
        await db.commit()


async def discover_link_samples_by_ids(sample_ids: list[int]) -> None:
    """iTunes + song_id eşlemesini istek dışında çalıştır (feed hızlı dönsün)."""
    if not sample_ids:
        return
    async with SessionLocal() as db:
        try:
            rows = list(
                (await db.scalars(select(DiscoverSample).where(DiscoverSample.id.in_(sample_ids)))).all()
            )
            if not rows:
                return
            await _apply_catalog_itunes_to_db(db, rows)
            await _resolve_missing_itunes(db, rows)
            rows = list(
                (await db.scalars(select(DiscoverSample).where(DiscoverSample.id.in_(sample_ids)))).all()
            )
            await _ensure_discover_song_ids(db, rows)
        except Exception:
            logger.exception("discover background link failed sample_ids=%s", sample_ids)


async def _likes_count_map(db: AsyncSession, sample_ids: list[int]) -> dict[int, int]:
    if not sample_ids:
        return {}
    rows = (
        await db.execute(
            select(DiscoverSampleLike.sample_id, func.count(DiscoverSampleLike.id))
            .where(DiscoverSampleLike.sample_id.in_(sample_ids))
            .group_by(DiscoverSampleLike.sample_id)
        )
    ).all()
    return {int(r[0]): int(r[1]) for r in rows}


async def _saves_count_map(db: AsyncSession, sample_ids: list[int]) -> dict[int, int]:
    if not sample_ids:
        return {}
    rows = (
        await db.execute(
            select(DiscoverSampleSave.sample_id, func.count(DiscoverSampleSave.id))
            .where(DiscoverSampleSave.sample_id.in_(sample_ids))
            .group_by(DiscoverSampleSave.sample_id)
        )
    ).all()
    return {int(r[0]): int(r[1]) for r in rows}


async def _comments_count_map(db: AsyncSession, sample_ids: list[int]) -> dict[int, int]:
    if not sample_ids:
        return {}
    rows = (
        await db.execute(
            select(DiscoverSampleComment.sample_id, func.count(DiscoverSampleComment.id))
            .where(DiscoverSampleComment.sample_id.in_(sample_ids))
            .group_by(DiscoverSampleComment.sample_id)
        )
    ).all()
    return {int(r[0]): int(r[1]) for r in rows}


async def _liked_ids(db: AsyncSession, user_id: int, sample_ids: list[int]) -> set[int]:
    if not sample_ids:
        return set()
    rows = (
        await db.scalars(
            select(DiscoverSampleLike.sample_id).where(
                DiscoverSampleLike.user_id == user_id,
                DiscoverSampleLike.sample_id.in_(sample_ids),
            )
        )
    ).all()
    return {int(x) for x in rows}


async def _saved_ids(db: AsyncSession, user_id: int, sample_ids: list[int]) -> set[int]:
    if not sample_ids:
        return set()
    rows = (
        await db.scalars(
            select(DiscoverSampleSave.sample_id).where(
                DiscoverSampleSave.user_id == user_id,
                DiscoverSampleSave.sample_id.in_(sample_ids),
            )
        )
    ).all()
    return {int(x) for x in rows}


async def _samples_to_out(
    db: AsyncSession,
    user: User,
    samples: list[DiscoverSample],
) -> list[DiscoverSampleOut]:
    ids = [s.id for s in samples]
    lc = await _likes_count_map(db, ids)
    sc = await _saves_count_map(db, ids)
    cc = await _comments_count_map(db, ids)
    liked = await _liked_ids(db, user.id, ids)
    saved = await _saved_ids(db, user.id, ids)
    out: list[DiscoverSampleOut] = []
    for s in samples:
        out.append(
            DiscoverSampleOut(
                id=s.id,
                artist_name=s.artist_name,
                title=s.title,
                video_url=s.video_url,
                hls_url=None,
                itunes_track_id=s.itunes_track_id,
                song_id=s.song_id,
                sort_order=s.sort_order,
                likes_count=lc.get(s.id, 0),
                saves_count=sc.get(s.id, 0),
                comments_count=cc.get(s.id, 0),
                liked_by_me=s.id in liked,
                saved_by_me=s.id in saved,
            )
        )
    return out


async def _catalog_to_out(
    db: AsyncSession,
    user: User,
    catalog: list[dict],
    background_tasks: BackgroundTasks,
) -> list[DiscoverSampleOut]:
    """Clip list and video URLs from static JSON; counts from DB. iTunes/song_id arka planda güncellenir."""
    settings = get_settings()
    ids = [int(c["id"]) for c in catalog]
    background_tasks.add_task(discover_link_samples_by_ids, list(ids))
    db_rows_list = list((await db.scalars(select(DiscoverSample).where(DiscoverSample.id.in_(ids)))).all())
    db_rows = {r.id: r for r in db_rows_list}

    lc = await _likes_count_map(db, ids)
    sc = await _saves_count_map(db, ids)
    cc = await _comments_count_map(db, ids)
    liked = await _liked_ids(db, user.id, ids)
    saved = await _saved_ids(db, user.id, ids)

    out: list[DiscoverSampleOut] = []
    for c in catalog:
        sid = int(c["id"])
        row = db_rows.get(sid)
        try:
            video_url = clip_video_url(settings, str(c["file"]))
        except ValueError:
            logger.warning("discover clip skipped id=%s invalid file=%r", sid, c.get("file"))
            continue
        hls_url_out: str | None = None
        if isinstance(c.get("hls_url"), str) and str(c["hls_url"]).strip():
            hls_url_out = str(c["hls_url"]).strip()
        elif c.get("hls_file"):
            try:
                hls_url_out = clip_video_url(settings, str(c["hls_file"]))
            except ValueError:
                hls_url_out = None
        itunes = row.itunes_track_id if row else None
        if itunes is None and c.get("itunes_track_id") is not None:
            try:
                itunes = int(c["itunes_track_id"])
            except (TypeError, ValueError):
                itunes = None
        sort_order = int(c.get("sort_order", 0))
        song_pk = row.song_id if row else None
        out.append(
            DiscoverSampleOut(
                id=sid,
                artist_name=str(c["artist_name"]),
                title=str(c["title"]),
                video_url=video_url,
                hls_url=hls_url_out,
                itunes_track_id=itunes,
                song_id=song_pk,
                sort_order=sort_order,
                likes_count=lc.get(sid, 0),
                saves_count=sc.get(sid, 0),
                comments_count=cc.get(sid, 0),
                liked_by_me=sid in liked,
                saved_by_me=sid in saved,
            )
        )
    return out


def _video_bundle_for_sample(settings, row: DiscoverSample) -> tuple[str, str | None]:
    """Resolve video_url and hls_url using catalog when present, else DB row."""
    if discover_clips_file_exists():
        catalog = load_discover_clip_catalog()
        c = next((x for x in catalog if int(x["id"]) == row.id), None)
        if c:
            video_url = clip_video_url(settings, str(c["file"]))
            hls_url_out: str | None = None
            if isinstance(c.get("hls_url"), str) and str(c["hls_url"]).strip():
                hls_url_out = str(c["hls_url"]).strip()
            elif c.get("hls_file"):
                try:
                    hls_url_out = clip_video_url(settings, str(c["hls_file"]))
                except ValueError:
                    hls_url_out = None
            return video_url, hls_url_out
    return row.video_url, None


@router.get("/video-for-song/{song_id}", response_model=DiscoverVideoForSongOut)
async def discover_video_for_song(
    song_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> DiscoverVideoForSongOut:
    """Keşfet ile DB'de eşlenmiş şarkı için aynı klip URL'lerini döner (arama / sıra ile aynı video)."""
    if await db.scalar(select(Song.id).where(Song.id == song_id)) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Song not found")
    row = await db.scalar(select(DiscoverSample).where(DiscoverSample.song_id == song_id))
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No discover clip linked to this song")
    settings = get_settings()
    try:
        video_url, hls_url = _video_bundle_for_sample(settings, row)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Invalid discover clip file") from exc
    return DiscoverVideoForSongOut(
        video_url=video_url,
        hls_url=hls_url,
        discover_sample_id=row.id,
    )


@router.get(
    "/feed",
    response_model=list[DiscoverSampleOut],
    summary="Discover feed",
    description="Video URL’leri hemen döner. iTunes / song_id eşlemesi arka planda çalışır; "
    "performans kontrolü için DevTools’ta bu isteğin kısa sürdüğünü ve video isteğinin "
    "paralel başladığını doğrulayın.",
)
async def discover_feed(
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[DiscoverSampleOut]:
    if discover_clips_file_exists():
        catalog = load_discover_clip_catalog()
        return await _catalog_to_out(db, current_user, catalog, background_tasks)

    samples = list(
        (await db.scalars(select(DiscoverSample).order_by(DiscoverSample.sort_order, DiscoverSample.id))).all()
    )
    background_tasks.add_task(discover_link_samples_by_ids, [s.id for s in samples])
    return await _samples_to_out(db, current_user, samples)


@router.get(
    "/samples/{sample_id}",
    response_model=DiscoverSampleOut,
    summary="Get one discover clip",
    description="Single clip by id for share links (#discover/{id}). Same auth as feed.",
)
async def discover_get_sample(
    sample_id: Annotated[int, Path(ge=1, description="Discover sample id.")],
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> DiscoverSampleOut:
    row = await db.get(DiscoverSample, sample_id)
    if row:
        background_tasks.add_task(discover_link_samples_by_ids, [sample_id])
        out = await _samples_to_out(db, current_user, [row])
        return out[0]
    if discover_clips_file_exists():
        catalog = load_discover_clip_catalog()
        c = next((x for x in catalog if int(x["id"]) == sample_id), None)
        if c:
            out = await _catalog_to_out(db, current_user, [c], background_tasks)
            return out[0]
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sample not found")


@router.get("/saved", response_model=list[DiscoverSampleOut])
async def discover_saved_feed(
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[DiscoverSampleOut]:
    save_rows = list(
        (
            await db.scalars(
                select(DiscoverSampleSave)
                .where(DiscoverSampleSave.user_id == current_user.id)
                .order_by(DiscoverSampleSave.created_at.desc())
            )
        )
        .all()
    )
    sample_ids = [s.sample_id for s in save_rows]
    if not sample_ids:
        return []
    if discover_clips_file_exists():
        catalog = load_discover_clip_catalog()
        by_id = {int(x["id"]): x for x in catalog}
        ordered_catalog = [by_id[i] for i in sample_ids if i in by_id]
        if ordered_catalog:
            return await _catalog_to_out(db, current_user, ordered_catalog, background_tasks)
    rows = list((await db.scalars(select(DiscoverSample).where(DiscoverSample.id.in_(sample_ids)))).all())
    row_by_id = {r.id: r for r in rows}
    ordered_rows = [row_by_id[i] for i in sample_ids if i in row_by_id]
    return await _samples_to_out(db, current_user, ordered_rows)


@router.get("/by-artist", response_model=list[DiscoverSampleOut])
async def discover_by_artist(
    artist: Annotated[str, Query(min_length=1, max_length=255)],
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[DiscoverSampleOut]:
    key = artist.strip().lower()
    if discover_clips_file_exists():
        catalog = load_discover_clip_catalog()
        filtered = [c for c in catalog if str(c["artist_name"]).strip().lower() == key]
        return await _catalog_to_out(db, current_user, filtered, background_tasks)

    samples = list(
        (
            await db.scalars(
                select(DiscoverSample)
                .where(func.lower(DiscoverSample.artist_name) == key)
                .order_by(DiscoverSample.sort_order, DiscoverSample.id)
            )
        ).all()
    )
    background_tasks.add_task(discover_link_samples_by_ids, [s.id for s in samples])
    return await _samples_to_out(db, current_user, samples)


@router.post("/samples/{sample_id}/like", response_model=DiscoverToggleState)
async def toggle_discover_like(
    sample_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> DiscoverToggleState:
    sample = await _ensure_discover_sample_row(db, sample_id)
    if not sample:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sample not found")

    existing = await db.scalar(
        select(DiscoverSampleLike).where(
            DiscoverSampleLike.user_id == current_user.id,
            DiscoverSampleLike.sample_id == sample_id,
        )
    )
    had_like = existing is not None
    if had_like:
        await db.delete(existing)
    else:
        db.add(DiscoverSampleLike(user_id=current_user.id, sample_id=sample_id))
    await db.commit()

    liked_now = (
        await db.scalar(
            select(DiscoverSampleLike.id).where(
                DiscoverSampleLike.user_id == current_user.id,
                DiscoverSampleLike.sample_id == sample_id,
            ).limit(1)
        )
        is not None
    )
    cnt = await db.scalar(
        select(func.count(DiscoverSampleLike.id)).where(DiscoverSampleLike.sample_id == sample_id)
    )
    return DiscoverToggleState(active=liked_now, likes_count=int(cnt or 0))


@router.post("/samples/{sample_id}/save", response_model=DiscoverToggleState)
async def toggle_discover_save(
    sample_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> DiscoverToggleState:
    sample = await _ensure_discover_sample_row(db, sample_id)
    if not sample:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sample not found")

    existing = await db.scalar(
        select(DiscoverSampleSave).where(
            DiscoverSampleSave.user_id == current_user.id,
            DiscoverSampleSave.sample_id == sample_id,
        )
    )
    had_save = existing is not None
    if had_save:
        await db.delete(existing)
    else:
        db.add(DiscoverSampleSave(user_id=current_user.id, sample_id=sample_id))
    await db.commit()

    saved_now = (
        await db.scalar(
            select(DiscoverSampleSave.id).where(
                DiscoverSampleSave.user_id == current_user.id,
                DiscoverSampleSave.sample_id == sample_id,
            ).limit(1)
        )
        is not None
    )
    cnt = await db.scalar(
        select(func.count(DiscoverSampleSave.id)).where(DiscoverSampleSave.sample_id == sample_id)
    )
    return DiscoverToggleState(active=saved_now, saves_count=int(cnt or 0))


@router.get("/samples/{sample_id}/comments", response_model=list[DiscoverCommentOut])
async def list_discover_comments(
    sample_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[DiscoverCommentOut]:
    if not await _discover_sample_reference_exists(db, sample_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sample not found")
    rows = (
        await db.execute(
            select(DiscoverSampleComment, User.username)
            .join(User, User.id == DiscoverSampleComment.user_id)
            .where(DiscoverSampleComment.sample_id == sample_id)
            .order_by(DiscoverSampleComment.created_at.asc())
        )
    ).all()
    id_to_username = {int(c.id): str(u) for c, u in rows}
    out: list[DiscoverCommentOut] = []
    for c, u in rows:
        pid = int(c.parent_id) if c.parent_id is not None else None
        reply_to = id_to_username.get(pid) if pid is not None else None
        out.append(
            DiscoverCommentOut(
                id=int(c.id),
                username=str(u),
                body=str(c.body),
                created_at=c.created_at,
                parent_id=pid,
                reply_to_username=reply_to,
            )
        )
    return out


@router.post("/samples/{sample_id}/comments", response_model=DiscoverCommentOut)
async def post_discover_comment(
    sample_id: int,
    payload: DiscoverCommentCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> DiscoverCommentOut:
    sample = await _ensure_discover_sample_row(db, sample_id)
    if not sample:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sample not found")

    body = payload.body.strip()
    parent_id = payload.parent_id
    parent_row: DiscoverSampleComment | None = None
    if parent_id is not None:
        parent_row = await db.get(DiscoverSampleComment, parent_id)
        if not parent_row or int(parent_row.sample_id) != int(sample_id):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid parent comment")

    single_token = body if " " not in body and "\n" not in body else None
    if single_token and single_token.startswith("https://") and not is_safe_sticker_url(single_token):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="GIF URL must use an allowed host (Giphy, Tenor, Discord CDN).",
        )

    comment = DiscoverSampleComment(
        user_id=current_user.id,
        sample_id=sample_id,
        parent_id=parent_id,
        body=body,
    )
    db.add(comment)
    await db.commit()
    await db.refresh(comment)
    reply_to_username = None
    if parent_row is not None:
        pu = await db.scalar(select(User.username).where(User.id == parent_row.user_id))
        reply_to_username = str(pu) if pu is not None else None
    return DiscoverCommentOut(
        id=comment.id,
        username=current_user.username,
        body=comment.body,
        created_at=comment.created_at,
        parent_id=int(comment.parent_id) if comment.parent_id is not None else None,
        reply_to_username=reply_to_username,
    )
