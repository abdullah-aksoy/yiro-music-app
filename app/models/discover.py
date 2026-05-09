from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class DiscoverSample(Base):
    __tablename__ = "discover_samples"
    __table_args__ = (Index("ix_discover_samples_artist_sort", "artist_name", "sort_order"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    artist_name: Mapped[str] = mapped_column(String(255), nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    video_url: Mapped[str] = mapped_column(Text, nullable=False)
    itunes_track_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    song_id: Mapped[int | None] = mapped_column(ForeignKey("songs.id", ondelete="SET NULL"), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    likes = relationship("DiscoverSampleLike", back_populates="sample", cascade="all, delete-orphan")
    saves = relationship("DiscoverSampleSave", back_populates="sample", cascade="all, delete-orphan")
    comments = relationship("DiscoverSampleComment", back_populates="sample", cascade="all, delete-orphan")


class DiscoverSampleLike(Base):
    __tablename__ = "discover_sample_likes"
    __table_args__ = (
        UniqueConstraint("user_id", "sample_id", name="uq_discover_like_user_sample"),
        Index("ix_discover_sample_likes_sample_id", "sample_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    sample_id: Mapped[int] = mapped_column(ForeignKey("discover_samples.id", ondelete="CASCADE"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    user = relationship("User", back_populates="discover_likes")
    sample = relationship("DiscoverSample", back_populates="likes")


class DiscoverSampleComment(Base):
    __tablename__ = "discover_sample_comments"
    __table_args__ = (
        Index("ix_discover_sample_comments_sample_id", "sample_id"),
        Index("ix_discover_sample_comments_created_at", "created_at"),
        Index("ix_discover_sample_comments_parent_id", "parent_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    sample_id: Mapped[int] = mapped_column(ForeignKey("discover_samples.id", ondelete="CASCADE"), nullable=False)
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("discover_sample_comments.id", ondelete="CASCADE"),
        nullable=True,
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    user = relationship("User", back_populates="discover_comments")
    sample = relationship("DiscoverSample", back_populates="comments")
    parent = relationship("DiscoverSampleComment", remote_side=[id], back_populates="replies")
    replies = relationship("DiscoverSampleComment", back_populates="parent")


class DiscoverSampleSave(Base):
    __tablename__ = "discover_sample_saves"
    __table_args__ = (
        UniqueConstraint("user_id", "sample_id", name="uq_discover_save_user_sample"),
        Index("ix_discover_sample_saves_sample_id", "sample_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    sample_id: Mapped[int] = mapped_column(ForeignKey("discover_samples.id", ondelete="CASCADE"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    user = relationship("User", back_populates="discover_saves")
    sample = relationship("DiscoverSample", back_populates="saves")
