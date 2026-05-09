from datetime import datetime

from pydantic import BaseModel

from app.schemas.song import SongBase


class SearchSong(SongBase):
    id: int | None = None
    file_path: str | None = None
    itunes_track_id: str | None = None
    is_local: bool
    created_at: datetime | None = None


class SearchResult(BaseModel):
    source: str
    songs: list[SearchSong]

