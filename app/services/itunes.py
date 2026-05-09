import asyncio
import re
import time
import unicodedata
from urllib.parse import quote_plus

import httpx

from app.config import get_settings

settings = get_settings()


def upgrade_itunes_artwork_url(url: str | None) -> str | None:
    """Prefer larger iTunes CDN artwork (e.g. 100x100bb -> 600x600bb)."""
    if not url:
        return url
    s = str(url).strip()
    if not s or "mzstatic.com" not in s.lower():
        return s
    s = re.sub(r"/\d+x\d+bb/", "/600x600bb/", s, flags=re.IGNORECASE)
    for small in ("30x30bb", "60x60bb", "100x100bb"):
        s = s.replace(small, "600x600bb")
    return s


class ITunesService:
    def __init__(self) -> None:
        self.base_url = settings.itunes_base_url
        self.country = settings.itunes_country
        self.cache_ttl_seconds = 300
        self._response_cache: dict[str, tuple[float, dict]] = {}
        self._http_client: httpx.AsyncClient | None = None

    async def startup(self) -> None:
        if self._http_client is None:
            self._http_client = httpx.AsyncClient(timeout=10.0)

    async def shutdown(self) -> None:
        if self._http_client is not None:
            await self._http_client.aclose()
            self._http_client = None

    def _build_search_url(self, term: str, *, entity: str = "song", limit: int = 10, extra: str = "") -> str:
        query = quote_plus(term)
        suffix = f"&{extra}" if extra else ""
        return (
            f"{self.base_url}/search?"
            f"term={query}&media=music&entity={entity}&limit={limit}&country={self.country}{suffix}"
        )

    def _build_lookup_url(
        self, lookup_id: int | str, *, entity: str | None = None, limit: int | None = None, sort: str | None = None
    ) -> str:
        parts = [f"{self.base_url}/lookup?id={lookup_id}"]
        if entity:
            parts.append(f"entity={entity}")
        if limit is not None:
            parts.append(f"limit={limit}")
        if sort:
            parts.append(f"sort={sort}")
        return "&".join(parts)

    async def _cached_get_json(self, url: str) -> dict:
        now = time.time()
        cached = self._response_cache.get(url)
        if cached and now - cached[0] <= self.cache_ttl_seconds:
            return cached[1]

        client = self._http_client
        if client is None:
            async with httpx.AsyncClient(timeout=10.0) as tmp:
                response = await tmp.get(url)
                response.raise_for_status()
                payload = response.json()
        else:
            response = await client.get(url)
            response.raise_for_status()
            payload = response.json()

        self._response_cache[url] = (now, payload)
        return payload

    @staticmethod
    def _normalize_artist_key(value: str) -> str:
        lowered = value.strip().lower()
        decomposed = unicodedata.normalize("NFKD", lowered)
        no_diacritics = "".join(char for char in decomposed if not unicodedata.combining(char))
        compact = re.sub(r"[^a-z0-9]+", " ", no_diacritics)
        return " ".join(compact.split())

    async def search_songs(self, term: str, limit: int = 10) -> list[dict]:
        url = self._build_search_url(term, entity="song", limit=limit)
        payload = await self._cached_get_json(url)
        return payload.get("results", [])

    async def lookup_song_track(self, track_id: int) -> dict | None:
        """Single track lookup (artwork + preview) for a known iTunes track id."""
        url = self._build_lookup_url(track_id)
        payload = await self._cached_get_json(url)
        for item in payload.get("results", []):
            if item.get("kind") != "song":
                continue
            tid = item.get("trackId")
            if tid is not None and int(tid) == int(track_id):
                return item
        for item in payload.get("results", []):
            if item.get("kind") == "song":
                return item
        return None

    async def get_trending_artists_tr(self, limit: int = 20) -> list[dict]:
        seed_terms = [
            "turkiye top songs",
            "turkce pop",
            "turkce rap",
            "arabesk",
            "turk sanat muzigi",
            "turk rock",
        ]
        per_seed_limit = max(10, min(25, limit))
        url_list = [
            self._build_search_url(term, entity="song", limit=per_seed_limit)
            for term in seed_terms
        ]
        unique_artists: dict[str, dict] = {}
        responses = await asyncio.gather(*(self._cached_get_json(url) for url in url_list), return_exceptions=True)
        for payload in responses:
            if isinstance(payload, Exception):
                continue
            for item in payload.get("results", []):
                artist_name = str(item.get("artistName") or "").strip()
                if not artist_name:
                    continue
                artist_key = self._normalize_artist_key(artist_name)
                if not artist_key or artist_key in unique_artists:
                    continue
                artwork_url = item.get("artworkUrl100") or item.get("artworkUrl60")
                unique_artists[artist_key] = {
                    "artist": artist_name,
                    "artwork_url": str(artwork_url) if artwork_url else None,
                }
                if len(unique_artists) >= limit:
                    break
            if len(unique_artists) >= limit:
                break
        return list(unique_artists.values())[:limit]

    async def get_artist_by_name_tr(self, artist_name: str) -> dict | None:
        """Resolve an iTunes musicArtist only when a result's name matches the query (normalized).

        Does not fall back to the first search hit — that allowed garbage URLs like ``manifestttt...``
        to open an unrelated artist.
        """
        if not artist_name.strip():
            return None
        url = self._build_search_url(
            artist_name,
            entity="musicArtist",
            limit=20,
            extra="attribute=artistTerm",
        )
        payload = await self._cached_get_json(url)
        target_key = self._normalize_artist_key(artist_name)
        if not target_key:
            return None
        for item in payload.get("results", []):
            candidate_name = str(item.get("artistName") or "").strip()
            candidate_key = self._normalize_artist_key(candidate_name)
            if not candidate_key:
                continue
            if candidate_key == target_key:
                return item
        return None

    async def get_artist_songs(self, artist_id: int, limit: int = 200) -> list[dict]:
        safe_limit = max(1, min(200, int(limit)))
        url = self._build_lookup_url(artist_id, entity="song", limit=200, sort="recent")
        payload = await self._cached_get_json(url)
        songs: list[dict] = []
        for item in payload.get("results", []):
            if item.get("wrapperType") != "track":
                continue
            if item.get("kind") != "song":
                continue
            songs.append(
                {
                    "artist_id": item.get("artistId"),
                    "artist": item.get("artistName") or "Unknown",
                    "collection_id": item.get("collectionId"),
                    "album": item.get("collectionName"),
                    "collection_view_url": item.get("collectionViewUrl"),
                    "itunes_track_id": str(item.get("trackId")) if item.get("trackId") else None,
                    "title": item.get("trackName") or item.get("collectionName") or "Unknown",
                    "genre": item.get("primaryGenreName"),
                    "duration_ms": item.get("trackTimeMillis"),
                    "artwork_url": upgrade_itunes_artwork_url(item.get("artworkUrl100") or item.get("artworkUrl60")),
                    "preview_url": item.get("previewUrl"),
                    "track_number": item.get("trackNumber"),
                    "track_view_url": item.get("trackViewUrl"),
                }
            )
        return songs[:safe_limit]

    async def get_artist_albums(self, artist_id: int, limit: int = 100) -> list[dict]:
        safe_limit = max(1, min(200, int(limit)))
        url = self._build_lookup_url(artist_id, entity="album", limit=200)
        payload = await self._cached_get_json(url)
        unique_albums: dict[int, dict] = {}
        for item in payload.get("results", []):
            if item.get("wrapperType") != "collection":
                continue
            if item.get("collectionType") != "Album":
                continue
            collection_id = item.get("collectionId")
            if not isinstance(collection_id, int) or collection_id in unique_albums:
                continue
            unique_albums[collection_id] = {
                "collection_id": collection_id,
                "title": item.get("collectionName") or "Unknown album",
                "artist": item.get("artistName") or "Unknown",
                "artwork_url": upgrade_itunes_artwork_url(item.get("artworkUrl100") or item.get("artworkUrl60")),
                "track_count": item.get("trackCount") or 0,
                "release_date": item.get("releaseDate"),
                "collection_view_url": item.get("collectionViewUrl"),
            }
            if len(unique_albums) >= safe_limit:
                break
        return list(unique_albums.values())[:safe_limit]

    async def get_artist_catalog(self, artist_id: int) -> tuple[list[dict], list[dict]]:
        """All unique songs for an artist: iTunes lookup (≤200) plus tracks from every album.

        Apple returns at most 200 songs per lookup; large discographies require walking albums.
        """
        songs_quick, albums = await asyncio.gather(
            self.get_artist_songs(artist_id, limit=200),
            self.get_artist_albums(artist_id, limit=200),
        )
        by_id: dict[str, dict] = {}
        for s in songs_quick:
            tid = s.get("itunes_track_id")
            if tid:
                by_id[str(tid)] = s

        sem = asyncio.Semaphore(8)

        async def load_album_tracks(album: dict) -> list[dict]:
            cid = album.get("collection_id")
            if not isinstance(cid, int):
                return []
            async with sem:
                try:
                    return await self.get_album_tracks(cid, limit=200)
                except Exception:
                    return []

        if albums:
            nested = await asyncio.gather(*[load_album_tracks(a) for a in albums])
            for track_list in nested:
                for t in track_list:
                    tid = t.get("itunes_track_id")
                    if not tid:
                        continue
                    k = str(tid)
                    if k not in by_id:
                        by_id[k] = t

        def _sort_key(s: dict) -> tuple[str, int, str]:
            album = str(s.get("album") or "")
            tn = int(s.get("track_number") or 0)
            title = str(s.get("title") or "")
            return (album.lower(), tn, title.lower())

        all_songs = sorted(by_id.values(), key=_sort_key)
        return all_songs, albums

    async def get_album_tracks(self, collection_id: int, limit: int = 200) -> list[dict]:
        safe_limit = max(1, min(200, int(limit)))
        url = self._build_lookup_url(collection_id, entity="song", limit=200)
        payload = await self._cached_get_json(url)
        tracks: list[dict] = []
        for item in payload.get("results", []):
            if item.get("wrapperType") != "track":
                continue
            if item.get("kind") != "song":
                continue
            tracks.append(
                {
                    "artist_id": item.get("artistId"),
                    "artist": item.get("artistName") or "Unknown",
                    "collection_id": item.get("collectionId"),
                    "album": item.get("collectionName"),
                    "collection_view_url": item.get("collectionViewUrl"),
                    "itunes_track_id": str(item.get("trackId")) if item.get("trackId") else None,
                    "title": item.get("trackName") or "Unknown",
                    "genre": item.get("primaryGenreName"),
                    "duration_ms": item.get("trackTimeMillis"),
                    "artwork_url": upgrade_itunes_artwork_url(item.get("artworkUrl100") or item.get("artworkUrl60")),
                    "preview_url": item.get("previewUrl"),
                    "track_number": item.get("trackNumber"),
                    "track_view_url": item.get("trackViewUrl"),
                }
            )
        return tracks[:safe_limit]


itunes_service = ITunesService()
