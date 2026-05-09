from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(50), unique=True, nullable=False)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    avatar_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    bio: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    playlists = relationship("Playlist", back_populates="user", cascade="all,delete-orphan")
    playlist_follows = relationship("PlaylistFollow", back_populates="user", cascade="all,delete-orphan")
    favorites = relationship("Favorite", back_populates="user", cascade="all,delete-orphan")
    listening_history = relationship("ListeningHistory", back_populates="user", cascade="all,delete-orphan")
    password_reset_tokens = relationship("PasswordResetToken", back_populates="user", cascade="all,delete-orphan")
    discover_likes = relationship("DiscoverSampleLike", back_populates="user", cascade="all, delete-orphan")
    discover_saves = relationship("DiscoverSampleSave", back_populates="user", cascade="all, delete-orphan")
    discover_comments = relationship("DiscoverSampleComment", back_populates="user", cascade="all, delete-orphan")

