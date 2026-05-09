from datetime import datetime

from pydantic import BaseModel, Field

from app.schemas.song import ITunesTrackIn
from app.utils.input_limits import QUEUE_REORDER_ITEM_IDS_MAX


class QueueItemAdd(ITunesTrackIn):
    song_id: int | None = None
    position: int | None = Field(default=None, ge=0)


class QueueItemOut(BaseModel):
    id: int
    user_id: int
    song_id: int | None = None
    title: str
    artist: str
    album: str | None = None
    artwork_url: str | None = None
    preview_url: str | None = None
    duration_ms: int | None = None
    is_local: bool
    file_path: str | None = None
    position: int
    created_at: datetime

    class Config:
        from_attributes = True


class QueueReorderIn(BaseModel):
    item_ids: list[int] = Field(min_length=1, max_length=QUEUE_REORDER_ITEM_IDS_MAX)

