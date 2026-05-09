import asyncio
import random
import sys
from pathlib import Path

from sqlalchemy import select

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from app.database import SessionLocal
from app.models.favorite import Favorite
from app.models.listening_history import ListeningHistory
from app.models.playlist import Playlist, PlaylistSong
from app.models.song import Song
from app.models.user import User
from app.utils.auth import get_password_hash
from scripts.common import print_header


MOCK_USERS = [
    {"username": "emre", "email": "emre@example.com", "password": "test1234"},
    {"username": "berat", "email": "berat@example.com", "password": "test1234"},
    {"username": "abdullah", "email": "abdullah@example.com", "password": "test1234"},
]


async def ensure_users() -> list[User]:
    created: list[User] = []
    async with SessionLocal() as db:
        for item in MOCK_USERS:
            existing = await db.scalar(select(User).where(User.email == item["email"]))
            if existing:
                # Keep the seed idempotent: align username if the email already exists.
                if existing.username != item["username"]:
                    existing.username = item["username"]
                created.append(existing)
                continue
            user = User(
                username=item["username"],
                email=item["email"],
                hashed_password=get_password_hash(item["password"]),
            )
            db.add(user)
            await db.flush()
            created.append(user)
        await db.commit()
    return created


async def seed_user_data(users: list[User]) -> None:
    async with SessionLocal() as db:
        songs = list((await db.execute(select(Song))).scalars().all())
        if not songs:
            print("No songs found. Run match_metadata.py first.")
            return

        for user in users:
            print_header(f"Seeding data for {user.username}")
            playlist_name = f"{user.username} Playlist"
            playlist = await db.scalar(
                select(Playlist).where(Playlist.user_id == user.id, Playlist.name == playlist_name)
            )
            if not playlist:
                playlist = Playlist(user_id=user.id, name=playlist_name, description="Mock playlist")
                db.add(playlist)
                await db.flush()

            playlist_song_ids = {
                row[0]
                for row in (
                    await db.execute(select(PlaylistSong.song_id).where(PlaylistSong.playlist_id == playlist.id))
                ).all()
            }
            favorite_song_ids = {
                row[0]
                for row in (
                    await db.execute(select(Favorite.song_id).where(Favorite.user_id == user.id))
                ).all()
            }

            sample_size = min(10, len(songs))
            selected = random.sample(songs, sample_size)
            for idx, song in enumerate(selected):
                if song.id not in playlist_song_ids:
                    db.add(PlaylistSong(playlist_id=playlist.id, song_id=song.id, position=idx))
                    playlist_song_ids.add(song.id)
                if song.id not in favorite_song_ids:
                    db.add(Favorite(user_id=user.id, song_id=song.id))
                    favorite_song_ids.add(song.id)

                existing_history = await db.scalar(
                    select(ListeningHistory.id).where(
                        ListeningHistory.user_id == user.id,
                        ListeningHistory.song_id == song.id,
                    )
                )
                if existing_history:
                    continue
                for _ in range(random.randint(1, 4)):
                    duration = song.duration_ms or 30000
                    db.add(
                        ListeningHistory(
                            user_id=user.id,
                            song_id=song.id,
                            listened_duration_ms=random.randint(max(1000, duration // 4), duration),
                        )
                    )
            print(f"Seeded user data: {user.username}")

        await db.commit()


async def main() -> None:
    users = await ensure_users()
    await seed_user_data(users)
    print("Mock user data seeded.")


if __name__ == "__main__":
    asyncio.run(main())

