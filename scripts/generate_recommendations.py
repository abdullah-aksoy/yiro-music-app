import asyncio
import sys
from pathlib import Path

from sqlalchemy import select

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from app.models.user import User
from app.services.recommendation import recommend_for_user
from scripts.common import print_header, print_list
from app.database import SessionLocal


async def main() -> None:
    async with SessionLocal() as db:
        users = list((await db.execute(select(User))).scalars().all())
        if not users:
            print("No users found.")
            return

        for user in users:
            songs = await recommend_for_user(db, user_id=user.id, limit=5)
            print_header(f"Recommendations for {user.username}:")
            rows = [f"- {song.artist} - {song.title} ({song.genre or 'unknown genre'})" for song in songs]
            print_list(rows, "- no recommendation available")


if __name__ == "__main__":
    asyncio.run(main())

