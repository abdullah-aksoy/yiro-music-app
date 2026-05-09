from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class UserFollow(Base):
    __tablename__ = "user_follows"
    __table_args__ = (
        UniqueConstraint("follower_user_id", "followed_user_id", name="uq_user_follows_pair"),
        Index("ix_user_follows_follower_created_at", "follower_user_id", "created_at"),
        Index("ix_user_follows_followed_user_id", "followed_user_id"),
        CheckConstraint("follower_user_id <> followed_user_id", name="ck_user_follows_not_self"),
    )


    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    follower_user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    followed_user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

