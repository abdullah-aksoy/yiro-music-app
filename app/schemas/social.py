from datetime import datetime

from pydantic import BaseModel


class FollowedUserOut(BaseModel):
    user_id: int
    username: str
    avatar_url: str | None = None
    bio: str | None = None
    followed_at: datetime


class FollowUserOut(BaseModel):
    user_id: int
    followed: bool

