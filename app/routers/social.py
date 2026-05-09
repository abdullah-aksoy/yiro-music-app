from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.social import UserFollow
from app.models.user import User
from app.schemas.social import FollowedUserOut, FollowUserOut
from app.utils.cache import cache_response, invalidate_user_endpoint_cache
from app.utils.deps import get_current_user

router = APIRouter(prefix="/social", tags=["social"])
_SOCIAL_MOD = "app.routers.social"


async def _invalidate_social_following_cache(user_id: int) -> None:
    await invalidate_user_endpoint_cache(
        user_id,
        key_prefix="social_following",
        module=_SOCIAL_MOD,
        function_name="list_following_users",
    )


@router.get(
    "/following",
    response_model=list[FollowedUserOut],
    summary="Following users",
    description="Lists users followed by current user.",
)
@cache_response("social_following", ttl=45)
async def list_following_users(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[FollowedUserOut]:
    rows = (
        await db.execute(
            select(User.id, User.username, User.avatar_url, User.bio, UserFollow.created_at)
            .join(UserFollow, UserFollow.followed_user_id == User.id)
            .where(UserFollow.follower_user_id == current_user.id)
            .order_by(UserFollow.created_at.desc())
        )
    ).all()
    return [
        FollowedUserOut(
            user_id=int(row[0]),
            username=str(row[1]),
            avatar_url=str(row[2]) if row[2] else None,
            bio=str(row[3]) if row[3] else None,
            followed_at=row[4],
        )
        for row in rows
    ]


@router.post(
    "/follow/{user_id:int}",
    response_model=FollowUserOut,
    summary="Follow user",
    description="Follows another user profile.",
)
async def follow_user(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> FollowUserOut:
    if user_id == current_user.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot follow yourself")
    target = await db.scalar(select(User).where(User.id == user_id))
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    existing = await db.scalar(
        select(UserFollow).where(UserFollow.follower_user_id == current_user.id, UserFollow.followed_user_id == user_id)
    )
    changed = False
    if not existing:
        db.add(UserFollow(follower_user_id=current_user.id, followed_user_id=user_id))
        try:
            await db.commit()
            changed = True
        except IntegrityError:
            await db.rollback()
    if changed:
        await _invalidate_social_following_cache(current_user.id)
    return FollowUserOut(user_id=user_id, followed=True)


@router.delete(
    "/follow/{user_id:int}",
    response_model=FollowUserOut,
    summary="Unfollow user",
    description="Unfollows a previously followed user.",
)
async def unfollow_user(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> FollowUserOut:
    existing = await db.scalar(
        select(UserFollow).where(UserFollow.follower_user_id == current_user.id, UserFollow.followed_user_id == user_id)
    )
    if existing:
        await db.delete(existing)
        await db.commit()
        await _invalidate_social_following_cache(current_user.id)
    return FollowUserOut(user_id=user_id, followed=False)

