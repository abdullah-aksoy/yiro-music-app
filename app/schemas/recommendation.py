from pydantic import BaseModel

from app.schemas.song import SongOut


class RecommendationWhyOut(BaseModel):
    song: SongOut
    reasons: list[str]
