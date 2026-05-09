from datetime import datetime

from fastapi import Form
from pydantic import BaseModel, Field

from app.utils.input_limits import (
    ITUNES_TRACK_ID_MAX,
    MEDIA_URL_MAX,
    SONG_ALBUM_MAX,
    SONG_ARTIST_MAX,
    SONG_GENRE_MAX,
    SONG_TITLE_MAX,
)


class ListeningHistoryCreate(BaseModel):
    song_id: int = Field(gt=0)
    listened_duration_ms: int = Field(default=0, ge=0)

    @classmethod
    def as_form(
        cls,
        song_id: int = Form(..., gt=0, examples=[1], description="Played song id. (Dinlenen sarki ID'si.)"),
        listened_duration_ms: int = Form(
            default=0,
            ge=0,
            examples=[125000],
            description="Listened duration in ms. (Dinlenen sure (ms).)",
        ),
    ) -> "ListeningHistoryCreate":
        return cls(song_id=song_id, listened_duration_ms=listened_duration_ms)


class ListeningHistoryCreateByItunes(BaseModel):
    itunes_track_id: str | None = Field(default=None, max_length=ITUNES_TRACK_ID_MAX)
    title: str | None = Field(default=None, max_length=SONG_TITLE_MAX)
    artist: str | None = Field(default=None, max_length=SONG_ARTIST_MAX)
    album: str | None = Field(default=None, max_length=SONG_ALBUM_MAX)
    genre: str | None = Field(default=None, max_length=SONG_GENRE_MAX)
    duration_ms: int | None = None
    artwork_url: str | None = Field(default=None, max_length=MEDIA_URL_MAX)
    preview_url: str | None = Field(default=None, max_length=MEDIA_URL_MAX)
    listened_duration_ms: int = Field(default=0, ge=0)

    @classmethod
    def as_form(
        cls,
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
        listened_duration_ms: int = Form(default=0, ge=0, examples=[120000]),
    ) -> "ListeningHistoryCreateByItunes":
        return cls(
            itunes_track_id=itunes_track_id,
            title=title,
            artist=artist,
            album=album,
            genre=genre,
            duration_ms=duration_ms,
            artwork_url=artwork_url,
            preview_url=preview_url,
            listened_duration_ms=listened_duration_ms,
        )

    def has_track_data(self) -> bool:
        return any(
            [
                self.itunes_track_id,
                self.title,
                self.artist,
                self.album,
                self.genre,
                self.duration_ms is not None,
                self.artwork_url,
                self.preview_url,
            ]
        )

    def to_itunes_payload(self) -> dict:
        return {
            "trackId": self.itunes_track_id,
            "trackName": self.title,
            "artistName": self.artist,
            "collectionName": self.album,
            "primaryGenreName": self.genre,
            "trackTimeMillis": self.duration_ms,
            "artworkUrl100": self.artwork_url,
            "previewUrl": self.preview_url,
        }


class ListeningHistorySongOut(BaseModel):
    id: int
    title: str
    artist: str
    album: str | None
    genre: str | None
    duration_ms: int | None
    file_path: str | None
    artwork_url: str | None
    itunes_track_id: str | None
    preview_url: str | None
    is_local: bool

    class Config:
        from_attributes = True


class ListeningHistoryOut(BaseModel):
    id: int
    user_id: int
    song_id: int | None
    listened_duration_ms: int
    listened_at: datetime

    class Config:
        from_attributes = True


class ListeningHistoryDetailedOut(ListeningHistoryOut):
    source_type: str = "local"
    track_title: str | None = None
    track_artist: str | None = None
    track_album: str | None = None
    track_genre: str | None = None
    track_duration_ms: int | None = None
    track_artwork_url: str | None = None
    track_preview_url: str | None = None
    track_itunes_id: str | None = None
    song: ListeningHistorySongOut | None = None


class ArtistListenerProfileOut(BaseModel):
    user_id: int
    username: str
    avatar_url: str | None = None
    bio: str | None = None
    play_count: int
    last_listened_at: datetime

