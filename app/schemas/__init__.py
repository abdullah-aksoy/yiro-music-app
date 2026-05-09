from app.schemas.analytics import TopArtistOut, TopGenreOut, TopTrackOut
from app.schemas.audio import AudioPreferencesIn, AudioPreferencesOut
from app.schemas.auth import Token, UserCreate, UserLogin, UserOut, UserUpdate
from app.schemas.history import ListeningHistoryCreate, ListeningHistoryOut
from app.schemas.library import (
    GenreCountOut,
    LibraryCollectionsOut,
    LibraryStatsOut,
    SavedAlbumIn,
    SavedAlbumOut,
    SavedArtistIn,
    SavedArtistOut,
)
from app.schemas.playlist import (
    PlaylistCreate,
    PlaylistDetail,
    PlaylistFeedItemOut,
    PlaylistFollowOut,
    PlaylistFollowerOut,
    PlaylistOut,
    PlaylistSongAdd,
    PlaylistStatsOut,
    PlaylistUpdate,
    PlaylistVisibilityUpdate,
)
from app.schemas.recommendation import RecommendationWhyOut
from app.schemas.social import FollowedUserOut, FollowUserOut
from app.schemas.search import SearchResult, SearchSong
from app.schemas.song import SongCreate, SongOut
from app.schemas.queue import QueueItemAdd, QueueItemOut, QueueReorderIn
from app.schemas.sync import (
    NotificationOut,
    SyncChangesOut,
    SyncFavoriteChangeOut,
    SyncHistoryChangeOut,
    SyncPlaylistChangeOut,
)

__all__ = [
    "AudioPreferencesIn",
    "AudioPreferencesOut",
    "FollowedUserOut",
    "FollowUserOut",
    "GenreCountOut",
    "LibraryCollectionsOut",
    "ListeningHistoryCreate",
    "ListeningHistoryOut",
    "LibraryStatsOut",
    "PlaylistCreate",
    "PlaylistDetail",
    "PlaylistFeedItemOut",
    "PlaylistFollowOut",
    "PlaylistFollowerOut",
    "PlaylistOut",
    "PlaylistSongAdd",
    "PlaylistStatsOut",
    "PlaylistUpdate",
    "PlaylistVisibilityUpdate",
    "QueueItemAdd",
    "QueueItemOut",
    "QueueReorderIn",
    "RecommendationWhyOut",
    "SavedAlbumIn",
    "SavedAlbumOut",
    "SavedArtistIn",
    "SavedArtistOut",
    "SearchResult",
    "SearchSong",
    "SongCreate",
    "SongOut",
    "NotificationOut",
    "SyncChangesOut",
    "SyncFavoriteChangeOut",
    "SyncHistoryChangeOut",
    "SyncPlaylistChangeOut",
    "Token",
    "TopArtistOut",
    "TopGenreOut",
    "TopTrackOut",
    "UserCreate",
    "UserLogin",
    "UserOut",
    "UserUpdate",
]
