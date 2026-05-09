from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Song(Base):
    __tablename__ = "songs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    artist: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    album: Mapped[str | None] = mapped_column(String(255), nullable=True)
    genre: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    file_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    artwork_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    itunes_track_id: Mapped[str | None] = mapped_column(String(64), nullable=True, unique=True)
    preview_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    is_local: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    playlist_links = relationship("PlaylistSong", back_populates="song", cascade="all,delete-orphan")
    favorites = relationship("Favorite", back_populates="song", cascade="all,delete-orphan")
    listening_history = relationship("ListeningHistory", back_populates="song", cascade="all,delete-orphan")

