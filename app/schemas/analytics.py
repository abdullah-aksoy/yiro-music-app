from typing import Literal

from pydantic import BaseModel, Field


class TopTrackOut(BaseModel):
    song_id: int
    title: str
    artist: str
    plays: int
    artwork_url: str | None = None


class TopArtistOut(BaseModel):
    artist: str
    plays: int
    artwork_url: str | None = None


class TopGenreOut(BaseModel):
    genre: str
    plays: int


class PopularArtistOut(BaseModel):
    artist: str
    artwork_url: str | None = None
    source: Literal["personal", "trending"]
    score: int | None = None
    reason: str | None = None


class ArtistSongOut(BaseModel):
    artist_id: int | None = None
    artist: str
    collection_id: int | None = None
    album: str | None = None
    collection_view_url: str | None = None
    itunes_track_id: str | None = None
    title: str
    genre: str | None = None
    duration_ms: int | None = None
    artwork_url: str | None = None
    preview_url: str | None = None
    track_number: int | None = None
    track_view_url: str | None = None


class ArtistAlbumOut(BaseModel):
    collection_id: int
    title: str
    artist: str
    artwork_url: str | None = None
    track_count: int = 0
    release_date: str | None = None
    collection_view_url: str | None = None


class ArtistDetailOut(BaseModel):
    artist: str
    artist_id: int | None = None
    artist_artwork_url: str | None = None
    songs: list[ArtistSongOut]
    songs_limit: int
    total_songs_available: int
    has_more: bool
    source: Literal["itunes", "fallback"]
    catalog_complete: bool = Field(
        default=True,
        description="False when songs are iTunes lookup-only; full album merge not done yet.",
    )
