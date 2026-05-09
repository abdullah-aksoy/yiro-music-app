from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class DiscoverSampleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    artist_name: str
    title: str
    video_url: str
    hls_url: str | None = None
    itunes_track_id: int | None = None
    song_id: int | None = None
    sort_order: int = 0
    likes_count: int = 0
    saves_count: int = 0
    comments_count: int = 0
    liked_by_me: bool = False
    saved_by_me: bool = False


class DiscoverVideoForSongOut(BaseModel):
    """Resolved Keşfet video for a DB song linked via discover_samples.song_id."""

    video_url: str
    hls_url: str | None = None
    discover_sample_id: int


class DiscoverToggleState(BaseModel):
    active: bool
    likes_count: int | None = None
    saves_count: int | None = None


class DiscoverCommentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    body: str
    created_at: datetime
    parent_id: int | None = None
    reply_to_username: str | None = None


class DiscoverCommentCreate(BaseModel):
    body: str = Field(min_length=1, max_length=2000)
    parent_id: int | None = Field(default=None)
