from datetime import datetime

from pydantic import BaseModel, Field


class AudioPreferencesIn(BaseModel):
    volume: float = Field(default=0.9, ge=0.0, le=1.0)


class AudioPreferencesOut(AudioPreferencesIn):
    user_id: int
    updated_at: datetime

