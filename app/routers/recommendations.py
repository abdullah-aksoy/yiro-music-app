from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.listening_history import ListeningHistory
from app.models.song import Song
from app.models.user import User
from app.schemas.recommendation import RecommendationWhyOut
from app.schemas.song import SongOut
from app.services.recommendation import recommend_for_user
from app.utils.deps import get_current_user
from app.utils.cache import cache_response

router = APIRouter(prefix="/recommendations", tags=["recommendations"])



@router.get(
    "",
    response_model=list[SongOut],
    summary="Recommendations",
    description="Returns personalized song recommendations. (Kullaniciya ozel sarki onerileri dondurur.)",
)
@cache_response("recommendations", ttl=300)
async def get_recommendations(

    limit: int = Query(default=10, ge=1, le=50),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list:
    songs = await recommend_for_user(db, user_id=current_user.id, limit=limit)
    return songs


@router.get(
    "/why",
    response_model=list[RecommendationWhyOut],
    summary="Recommendations with reasons",
    description="Returns recommendations together with reason codes. (Onerileri neden kodlariyla birlikte dondurur.)",
)
@cache_response("recommendations_why", ttl=300)
async def get_recommendations_with_reasons(

    limit: int = Query(default=10, ge=1, le=50, description="Maximum recommendation count."),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[RecommendationWhyOut]:
    songs = await recommend_for_user(db, user_id=current_user.id, limit=limit)

    top_genre_rows = (
        await db.execute(
            select(Song.genre, func.count(ListeningHistory.id))
            .join(ListeningHistory, ListeningHistory.song_id == Song.id)
            .where(ListeningHistory.user_id == current_user.id, Song.genre.is_not(None))
            .group_by(Song.genre)
            .order_by(func.count(ListeningHistory.id).desc())
            .limit(3)
        )
    ).all()
    top_genres = {str(row[0]).lower() for row in top_genre_rows if row[0]}

    response: list[RecommendationWhyOut] = []
    for song in songs:
        reasons: list[str] = []
        if song.genre and song.genre.lower() in top_genres:
            reasons.append("genre_match")
        if not reasons:
            reasons.append("collaborative_signal")
        response.append(RecommendationWhyOut(song=SongOut.model_validate(song), reasons=reasons))
    return response

