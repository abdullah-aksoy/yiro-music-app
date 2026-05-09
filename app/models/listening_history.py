from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class ListeningHistory(Base):
    __tablename__ = "listening_history"
    __table_args__ = (
        Index("ix_listening_history_user_id_listened_at", "user_id", "listened_at"),
        CheckConstraint("listened_duration_ms >= 0", name="ck_listening_history_duration_nonnegative"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    song_id: Mapped[int | None] = mapped_column(ForeignKey("songs.id", ondelete="CASCADE"), nullable=True, index=True)
    source_type: Mapped[str] = mapped_column(String(16), nullable=False, default="local")
    track_title: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    track_artist: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    track_album: Mapped[str | None] = mapped_column(String(255), nullable=True)
    track_genre: Mapped[str | None] = mapped_column(String(100), nullable=True)
    track_duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    track_artwork_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    track_preview_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    track_itunes_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    listened_duration_ms: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    listened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    user = relationship("User", back_populates="listening_history")
    song = relationship("Song", back_populates="listening_history")

