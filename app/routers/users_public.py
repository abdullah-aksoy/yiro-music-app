from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.models.playlist import Playlist, PlaylistFollow
from app.models.user import User
from app.schemas.playlist import PlaylistOut
from app.utils.deps import get_current_user
from app.utils.input_limits import USERNAME_MAX

router = APIRouter(prefix="/users", tags=["users"])
me_router = APIRouter(prefix="/me", tags=["users"])


def _to_playlist_out(playlist: Playlist, *, is_followed: bool = False) -> PlaylistOut:
    return PlaylistOut(
        id=playlist.id,
        user_id=playlist.user_id,
        owner_username=playlist.user.username if playlist.user else "unknown",
        name=playlist.name,
        description=playlist.description,
        is_public=playlist.is_public,
        created_at=playlist.created_at,
        updated_at=playlist.updated_at,
        is_followed=is_followed,
    )


@router.get(
    "/{username}/playlists",
    response_model=list[PlaylistOut],
    summary="User public playlists",
    description="Returns public playlists owned by the given username.",
)
async def get_user_public_playlists(
    username: Annotated[str, Path(min_length=1, max_length=USERNAME_MAX)],
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[PlaylistOut]:
    owner = await db.scalar(select(User).where(User.username == username))
    if not owner:
        raise HTTPException(status_code=404, detail="User not found")

    playlists = list(
        (
            await db.execute(
                select(Playlist)
                .options(selectinload(Playlist.user))
                .where(Playlist.user_id == owner.id, Playlist.is_public.is_(True))
                .order_by(Playlist.updated_at.desc())
            )
        ).scalars().all()
    )
    followed_ids = set(
        (
            await db.execute(
                select(PlaylistFollow.playlist_id).where(
                    PlaylistFollow.user_id == current_user.id,
                    PlaylistFollow.playlist_id.in_([item.id for item in playlists] or [-1]),
                )
            )
        ).scalars().all()
    )
    return [_to_playlist_out(item, is_followed=item.id in followed_ids) for item in playlists]


@me_router.get(
    "/following/playlists",
    response_model=list[PlaylistOut],
    summary="My followed playlists",
    description="Returns public playlists followed by current user. Deprecated alias of /playlists/following.",
    deprecated=True,
)
async def get_my_followed_playlists(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[PlaylistOut]:
    rows = (
        await db.execute(
            select(Playlist)
            .join(PlaylistFollow, PlaylistFollow.playlist_id == Playlist.id)
            .options(selectinload(Playlist.user))
            .where(PlaylistFollow.user_id == current_user.id)
            .order_by(Playlist.updated_at.desc())
        )
    ).scalars().all()
    return [_to_playlist_out(item, is_followed=True) for item in rows]
