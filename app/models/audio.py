from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Integer, func, Boolean
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class AudioPreference(Base):
    __tablename__ = "audio_preferences"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), unique=True, nullable=False, index=True)
    volume: Mapped[float] = mapped_column(Float, default=0.9, nullable=False)
    crossfade_sec: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    gapless_playback: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

