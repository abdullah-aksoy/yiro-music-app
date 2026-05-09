from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class SavedArtist(Base):
    __tablename__ = "saved_artists"
    __table_args__ = (
        UniqueConstraint("user_id", "artist_name", name="uq_saved_artists_user_artist"),
        Index("ix_saved_artists_user_id_created_at", "user_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    artist_name: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class SavedAlbum(Base):
    __tablename__ = "saved_albums"
    __table_args__ = (
        UniqueConstraint("user_id", "album_title", "artist_name", name="uq_saved_albums_user_album_artist"),
        Index("ix_saved_albums_user_id_created_at", "user_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    album_title: Mapped[str] = mapped_column(String(255), nullable=False)
    artist_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

