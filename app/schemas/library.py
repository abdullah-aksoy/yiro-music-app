from pydantic import BaseModel


class LibrarySummaryOut(BaseModel):
    favorites_count: int
    playlists_count: int
    recent_plays_count: int
    total_listen_ms: int


class GenreCountOut(BaseModel):
    genre: str
    plays: int


class LibraryStatsOut(BaseModel):
    total_listen_ms: int
    last_7_days_listen_ms: int
    last_30_days_listen_ms: int
    top_genres: list[GenreCountOut]


class SavedArtistIn(BaseModel):
    artist_name: str


class SavedAlbumIn(BaseModel):
    album_title: str
    artist_name: str | None = None


class SavedArtistOut(BaseModel):
    id: int
    artist_name: str

    class Config:
        from_attributes = True


class SavedAlbumOut(BaseModel):
    id: int
    album_title: str
    artist_name: str | None = None

    class Config:
        from_attributes = True


class LibraryCollectionsOut(BaseModel):
    saved_artists: list[SavedArtistOut]
    saved_albums: list[SavedAlbumOut]
