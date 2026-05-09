from datetime import datetime

from fastapi import Form
from pydantic import BaseModel, Field

from app.utils.input_limits import (
    ITUNES_TRACK_ID_MAX,
    LOCAL_FILE_PATH_MAX,
    MEDIA_URL_MAX,
    SONG_ALBUM_MAX,
    SONG_ARTIST_MAX,
    SONG_GENRE_MAX,
    SONG_RELATIONS_BATCH_MAX,
    SONG_TITLE_MAX,
)


class SongBase(BaseModel):
    title: str = Field(max_length=SONG_TITLE_MAX)
    artist: str = Field(max_length=SONG_ARTIST_MAX)
    album: str | None = Field(default=None, max_length=SONG_ALBUM_MAX)
    genre: str | None = Field(default=None, max_length=SONG_GENRE_MAX)
    duration_ms: int | None = None
    artwork_url: str | None = Field(default=None, max_length=MEDIA_URL_MAX)
    preview_url: str | None = Field(default=None, max_length=MEDIA_URL_MAX)


class SongCreate(SongBase):
    file_path: str | None = Field(default=None, max_length=LOCAL_FILE_PATH_MAX)
    itunes_track_id: str | None = Field(default=None, max_length=ITUNES_TRACK_ID_MAX)
    is_local: bool = True

    @classmethod
    def as_form(
        cls,
        title: str = Form(
            ...,
            max_length=SONG_TITLE_MAX,
            examples=["Shape of You"],
            description="Song title. (Sarki basligi.)",
        ),
        artist: str = Form(
            ...,
            max_length=SONG_ARTIST_MAX,
            examples=["Ed Sheeran"],
            description="Artist name. (Sanatci adi.)",
        ),
        album: str | None = Form(
            default=None,
            max_length=SONG_ALBUM_MAX,
            examples=["Divide"],
            description="Album name. (Album adi.)",
        ),
        genre: str | None = Form(
            default=None,
            max_length=SONG_GENRE_MAX,
            examples=["Pop"],
            description="Genre name. (Tur bilgisi.)",
        ),
        duration_ms: int | None = Form(default=None, examples=[233712], description="Duration in ms. (Sure (ms).)"),
        artwork_url: str | None = Form(
            default=None,
            max_length=MEDIA_URL_MAX,
            examples=["https://example.com/art.jpg"],
            description="Artwork image URL. (Kapak gorseli URL.)",
        ),
        preview_url: str | None = Form(
            default=None,
            max_length=MEDIA_URL_MAX,
            examples=["https://example.com/preview.m4a"],
            description="Audio preview URL. (Onizleme ses URL.)",
        ),
        file_path: str | None = Form(
            default=None,
            max_length=LOCAL_FILE_PATH_MAX,
            examples=["music/Ed Sheeran - Shape of You.mp3"],
            description="Local file path. (Lokal dosya yolu.)",
        ),
        itunes_track_id: str | None = Form(
            default=None,
            max_length=ITUNES_TRACK_ID_MAX,
            examples=["1193701079"],
            description="iTunes track identifier. (iTunes parca kimligi.)",
        ),
        is_local: bool = Form(default=True, examples=[True], description="Whether it is local. (Lokal mi?)"),
    ) -> "SongCreate":
        return cls(
            title=title,
            artist=artist,
            album=album,
            genre=genre,
            duration_ms=duration_ms,
            artwork_url=artwork_url,
            preview_url=preview_url,
            file_path=file_path,
            itunes_track_id=itunes_track_id,
            is_local=is_local,
        )


class ITunesTrackIn(BaseModel):
    itunes_track_id: str | None = Field(default=None, max_length=ITUNES_TRACK_ID_MAX)
    title: str | None = Field(default=None, max_length=SONG_TITLE_MAX)
    artist: str | None = Field(default=None, max_length=SONG_ARTIST_MAX)
    album: str | None = Field(default=None, max_length=SONG_ALBUM_MAX)
    genre: str | None = Field(default=None, max_length=SONG_GENRE_MAX)
    duration_ms: int | None = None
    artwork_url: str | None = Field(default=None, max_length=MEDIA_URL_MAX)
    preview_url: str | None = Field(default=None, max_length=MEDIA_URL_MAX)

    @classmethod
    def as_form(
        cls,
        itunes_track_id: str | None = Form(
            default=None,
            max_length=ITUNES_TRACK_ID_MAX,
            examples=["1193701079"],
            description="iTunes ID. (iTunes ID.)",
        ),
        title: str | None = Form(
            default=None,
            max_length=SONG_TITLE_MAX,
            examples=["Shape of You"],
            description="Track title. (Sarki adi.)",
        ),
        artist: str | None = Form(
            default=None,
            max_length=SONG_ARTIST_MAX,
            examples=["Ed Sheeran"],
            description="Artist. (Sanatci adi.)",
        ),
        album: str | None = Form(
            default=None,
            max_length=SONG_ALBUM_MAX,
            examples=["Divide"],
            description="Album. (Album adi.)",
        ),
        genre: str | None = Form(
            default=None,
            max_length=SONG_GENRE_MAX,
            examples=["Pop"],
            description="Genre. (Tur.)",
        ),
        duration_ms: int | None = Form(default=None, examples=[233712], description="Duration. (Sure (ms).)"),
        artwork_url: str | None = Form(
            default=None,
            max_length=MEDIA_URL_MAX,
            examples=["https://example.com/art.jpg"],
            description="Artwork URL. (Kapak URL.)",
        ),
        preview_url: str | None = Form(
            default=None,
            max_length=MEDIA_URL_MAX,
            examples=["https://example.com/preview.m4a"],
            description="Preview URL. (Onizleme URL.)",
        ),
    ) -> "ITunesTrackIn":
        return cls(
            itunes_track_id=itunes_track_id,
            title=title,
            artist=artist,
            album=album,
            genre=genre,
            duration_ms=duration_ms,
            artwork_url=artwork_url,
            preview_url=preview_url,
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


class SongOut(SongBase):
    id: int
    file_path: str | None = None
    itunes_track_id: str | None = None
    is_local: bool
    created_at: datetime

    class Config:
        from_attributes = True


class SongRelationPlaylistOut(BaseModel):
    id: int
    name: str


class SongRelationsOut(BaseModel):
    song_id: int
    favorited: bool
    playlists: list[SongRelationPlaylistOut]


class SongRelationsBatchIn(BaseModel):
    """Up to 50 song IDs per request; duplicates are deduplicated preserving order."""

    song_ids: list[int] = Field(min_length=1, max_length=SONG_RELATIONS_BATCH_MAX)

