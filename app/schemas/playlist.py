from datetime import datetime

from fastapi import Form
from pydantic import BaseModel, Field

from app.schemas.song import ITunesTrackIn, SongOut
from app.utils.input_limits import (
    ITUNES_TRACK_ID_MAX,
    MEDIA_URL_MAX,
    PLAYLIST_REORDER_SONG_IDS_MAX,
    SONG_ALBUM_MAX,
    SONG_ARTIST_MAX,
    SONG_GENRE_MAX,
    SONG_TITLE_MAX,
)


class PlaylistCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=500)

    @classmethod
    def as_form(
        cls,
        name: str = Form(
            ...,
            min_length=1,
            max_length=255,
            examples=["Morning Chill"],
            description="Playlist name. (Playlist adi.)",
        ),
        description: str | None = Form(
            default=None,
            max_length=500,
            examples=["Soft songs for work."],
            description="Playlist description. (Playlist aciklamasi.)",
        ),
    ) -> "PlaylistCreate":
        return cls(name=name, description=description)


class PlaylistUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=500)

    @classmethod
    def as_form(
        cls,
        name: str | None = Form(
            default=None,
            min_length=1,
            max_length=255,
            examples=["Updated Playlist"],
            description="New playlist name. (Yeni playlist adi.)",
        ),
        description: str | None = Form(
            default=None,
            max_length=500,
            examples=["Updated description."],
            description="New description. (Yeni aciklama.)",
        ),
    ) -> "PlaylistUpdate":
        return cls(name=name, description=description)


class PlaylistSongAdd(ITunesTrackIn):
    song_id: int | None = None
    position: int = 0

    @classmethod
    def as_form(
        cls,
        song_id: int | None = Form(default=None, examples=[12], description="Existing song id. (Var olan sarki ID'si.)"),
        itunes_track_id: str | None = Form(default=None, max_length=ITUNES_TRACK_ID_MAX, examples=["1193701079"]),
        title: str | None = Form(default=None, max_length=SONG_TITLE_MAX, examples=["Shape of You"]),
        artist: str | None = Form(default=None, max_length=SONG_ARTIST_MAX, examples=["Ed Sheeran"]),
        album: str | None = Form(default=None, max_length=SONG_ALBUM_MAX, examples=["Divide"]),
        genre: str | None = Form(default=None, max_length=SONG_GENRE_MAX, examples=["Pop"]),
        duration_ms: int | None = Form(default=None, examples=[233712]),
        artwork_url: str | None = Form(
            default=None,
            max_length=MEDIA_URL_MAX,
            examples=["https://example.com/art.jpg"],
        ),
        preview_url: str | None = Form(
            default=None,
            max_length=MEDIA_URL_MAX,
            examples=["https://example.com/preview.m4a"],
        ),
        position: int = Form(default=0, ge=0, examples=[0], description="Position in playlist. (Playlist sirasi.)"),
    ) -> "PlaylistSongAdd":
        return cls(
            song_id=song_id,
            itunes_track_id=itunes_track_id,
            title=title,
            artist=artist,
            album=album,
            genre=genre,
            duration_ms=duration_ms,
            artwork_url=artwork_url,
            preview_url=preview_url,
            position=position,
        )


class PlaylistOut(BaseModel):
    id: int
    user_id: int
    owner_username: str
    name: str
    description: str | None
    is_public: bool
    created_at: datetime
    updated_at: datetime
    is_followed: bool = False

    class Config:
        from_attributes = True


class PlaylistDetail(PlaylistOut):
    songs: list[SongOut]


class PlaylistVisibilityUpdate(BaseModel):
    is_public: bool


class PlaylistFollowOut(BaseModel):
    playlist_id: int
    followed: bool


class PlaylistSongReorderIn(BaseModel):
    song_ids: list[int] = Field(min_length=1, max_length=PLAYLIST_REORDER_SONG_IDS_MAX)


class PlaylistFollowerOut(BaseModel):
    user_id: int
    username: str
    followed_at: datetime


class PlaylistStatsOut(BaseModel):
    playlist_id: int
    song_count: int
    follower_count: int
    is_followed: bool
    updated_at: datetime


class PlaylistFeedItemOut(BaseModel):
    playlist_id: int
    playlist_name: str
    owner_username: str
    updated_at: datetime

