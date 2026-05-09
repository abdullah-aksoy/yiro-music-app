from datetime import datetime

from pydantic import BaseModel


class SyncPlaylistChangeOut(BaseModel):
    playlist_id: int
    name: str
    owner_username: str
    is_public: bool
    updated_at: datetime


class SyncFavoriteChangeOut(BaseModel):
    song_id: int
    created_at: datetime


class SyncHistoryChangeOut(BaseModel):
    history_id: int
    song_id: int | None
    listened_at: datetime
    listened_duration_ms: int


class SyncChangesOut(BaseModel):
    since: datetime
    server_time: datetime
    playlists: list[SyncPlaylistChangeOut]
    favorites: list[SyncFavoriteChangeOut]
    history: list[SyncHistoryChangeOut]


class NotificationOut(BaseModel):
    type: str
    playlist_id: int
    playlist_name: str
    owner_username: str
    occurred_at: datetime
