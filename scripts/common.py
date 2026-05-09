from collections.abc import Sequence

from sqlalchemy import Select

from app.database import SessionLocal


async def fetch_all(stmt: Select):
    async with SessionLocal() as db:
        return list((await db.execute(stmt)).scalars().all())


def print_header(title: str) -> None:
    print(f"\n{title}")


def print_list(items: Sequence[str], empty_message: str) -> None:
    if not items:
        print(empty_message)
        return
    for item in items:
        print(item)
