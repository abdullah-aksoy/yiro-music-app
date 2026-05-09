from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.queue import QueueItem
from app.models.song import Song
from app.models.user import User
from app.schemas.queue import QueueItemAdd, QueueItemOut, QueueReorderIn
from app.services.song_store import get_or_create_song_from_itunes
from app.utils.cache import cache_response, invalidate_user_endpoint_cache
from app.utils.deps import get_current_user

router = APIRouter(prefix="/queue", tags=["queue"])
_QUEUE_MOD = "app.routers.queue"


async def _invalidate_queue_list_cache(user_id: int) -> None:
    await invalidate_user_endpoint_cache(
        user_id,
        key_prefix="queue_list",
        module=_QUEUE_MOD,
        function_name="get_queue",
    )


def _to_queue_song_payload(song: Song) -> dict:
    return {
        "song_id": song.id,
        "title": song.title,
        "artist": song.artist,
        "album": song.album,
        "artwork_url": song.artwork_url,
        "preview_url": song.preview_url,
        "is_local": bool(song.is_local),
        "file_path": song.file_path,
        "duration_ms": song.duration_ms,
    }


@router.get(
    "",
    response_model=list[QueueItemOut],
    summary="Get queue",
    description="Returns user's current queue items ordered by position.",
)
@cache_response("queue_list", ttl=30)
async def get_queue(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[QueueItem]:
    items = list(
        (
            await db.execute(
                select(QueueItem).where(QueueItem.user_id == current_user.id).order_by(QueueItem.position.asc())
            )
        )
        .scalars()
        .all()
    )
    return items


@router.post(
    "/items",
    response_model=QueueItemOut,
    status_code=status.HTTP_201_CREATED,
    summary="Add queue item",
    description="Adds a song to queue by song_id or iTunes metadata.",
)
async def add_queue_item(
    payload: QueueItemAdd,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> QueueItemOut:
    song: Song | None = None
    if payload.song_id:
        song = await db.scalar(select(Song).where(Song.id == payload.song_id))
    elif payload.has_track_data():
        song = await get_or_create_song_from_itunes(db, payload.to_itunes_payload())

    if not song:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Song payload is invalid")

    max_position = await db.scalar(select(func.max(QueueItem.position)).where(QueueItem.user_id == current_user.id))
    next_position = 0 if max_position is None else int(max_position) + 1
    insert_position = next_position if payload.position is None else min(int(payload.position), next_position)
    await db.execute(
        update(QueueItem)
        .where(QueueItem.user_id == current_user.id, QueueItem.position >= insert_position)
        .values(position=QueueItem.position + 1)
    )

    item = QueueItem(user_id=current_user.id, position=insert_position, **_to_queue_song_payload(song))
    db.add(item)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Queue mutation conflicted with another request. Please retry.",
        ) from exc
    await db.refresh(item)
    await _invalidate_queue_list_cache(current_user.id)
    return QueueItemOut.model_validate(item)


@router.delete(
    "/items/{item_id:int}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Remove queue item",
    description="Removes one queue item and compacts positions.",
)
async def remove_queue_item(
    item_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    item = await db.scalar(select(QueueItem).where(QueueItem.id == item_id, QueueItem.user_id == current_user.id))
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Queue item not found")
    removed_position = item.position
    await db.delete(item)
    await db.execute(
        update(QueueItem)
        .where(QueueItem.user_id == current_user.id, QueueItem.position > removed_position)
        .values(position=QueueItem.position - 1)
    )
    await db.commit()
    await _invalidate_queue_list_cache(current_user.id)
    return None


@router.post(
    "/clear",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Clear queue",
    description="Clears all items in user's queue.",
)
async def clear_queue(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    items = list((await db.execute(select(QueueItem).where(QueueItem.user_id == current_user.id))).scalars().all())
    for item in items:
        await db.delete(item)
    await db.commit()
    await _invalidate_queue_list_cache(current_user.id)
    return None


@router.patch(
    "/reorder",
    summary="Reorder queue",
    description="Updates queue order by exact ordered item IDs.",
)
async def reorder_queue(
    payload: QueueReorderIn,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    items = list((await db.execute(select(QueueItem).where(QueueItem.user_id == current_user.id))).scalars().all())
    existing = [item.id for item in items]
    if sorted(existing) != sorted(payload.item_ids):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="item_ids mismatch with existing queue")
    new_positions = {item_id: idx for idx, item_id in enumerate(payload.item_ids)}
    for item in items:
        item.position = new_positions[item.id]
    await db.commit()
    await _invalidate_queue_list_cache(current_user.id)
    return {"message": "Queue reordered"}

