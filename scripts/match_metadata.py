import asyncio
import sys
from pathlib import Path

from mutagen.mp3 import MP3
from sqlalchemy import select

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from app.config import get_settings
from app.database import SessionLocal
from app.models.song import Song
from app.services.audio import get_music_root, validate_local_file_path
from app.services.itunes import itunes_service
from scripts.common import print_header

settings = get_settings()


def extract_track_artist(path: Path) -> tuple[str, str]:
    name = path.stem
    if " - " in name:
        left, right = [part.strip() for part in name.split(" - ", 1)]
        artist, track = left, right
        if right and right.isupper():
            artist, track = right, left
        return track.strip(), artist.strip()
    return name.strip(), "Unknown"


def get_duration_ms(path: Path) -> int | None:
    try:
        audio = MP3(path)
        return int(audio.info.length * 1000)
    except Exception:
        return None


async def main() -> None:
    music_dir = get_music_root()
    if not music_dir.exists():
        print(f"Music directory not found: {music_dir}")
        return

    files = sorted(music_dir.glob("*.mp3"))
    if not files:
        print("No mp3 files found.")
        return

    async with SessionLocal() as db:
        print_header("Matching local files with iTunes metadata")
        for path in files:
            track, artist = extract_track_artist(path)
            search_term = f"{artist} {track}".strip()
            try:
                results = await itunes_service.search_songs(search_term, limit=1)
            except Exception as exc:
                print(f"Skipped {path.name}: iTunes lookup failed ({exc})")
                continue
            item = results[0] if results else {}

            rel_path = path.resolve().relative_to(music_dir).as_posix()
            file_path = validate_local_file_path(rel_path)
            existing = await db.scalar(select(Song).where(Song.file_path == file_path))
            if existing:
                existing.title = item.get("trackName", track)
                existing.artist = item.get("artistName", artist)
                existing.album = item.get("collectionName")
                existing.genre = item.get("primaryGenreName")
                existing.duration_ms = item.get("trackTimeMillis") or get_duration_ms(path)
                existing.artwork_url = item.get("artworkUrl100") or item.get("artworkUrl60")
                existing.preview_url = item.get("previewUrl")
                existing.itunes_track_id = str(item.get("trackId")) if item.get("trackId") else None
                existing.is_local = True
            else:
                db.add(
                    Song(
                        title=item.get("trackName", track),
                        artist=item.get("artistName", artist),
                        album=item.get("collectionName"),
                        genre=item.get("primaryGenreName"),
                        duration_ms=item.get("trackTimeMillis") or get_duration_ms(path),
                        file_path=file_path,
                        artwork_url=item.get("artworkUrl100") or item.get("artworkUrl60"),
                        preview_url=item.get("previewUrl"),
                        itunes_track_id=str(item.get("trackId")) if item.get("trackId") else None,
                        is_local=True,
                    )
                )
            print(f"Processed: {path.name}")

        await db.commit()
    print("Metadata matching completed.")


if __name__ == "__main__":
    asyncio.run(main())

