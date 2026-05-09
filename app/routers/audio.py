from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.audio import AudioPreference
from app.models.user import User
from app.schemas.audio import AudioPreferencesIn, AudioPreferencesOut
from app.utils.cache import cache_response, invalidate_user_endpoint_cache
from app.utils.deps import get_current_user

router = APIRouter(prefix="/audio", tags=["audio"])
_AUDIO_MOD = "app.routers.audio"


async def _get_or_create_prefs(db: AsyncSession, user_id: int) -> AudioPreference:
    prefs = await db.scalar(select(AudioPreference).where(AudioPreference.user_id == user_id))
    if prefs:
        return prefs
    prefs = AudioPreference(user_id=user_id, volume=0.9, crossfade_sec=0, gapless_playback=True)
    db.add(prefs)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        existing = await db.scalar(select(AudioPreference).where(AudioPreference.user_id == user_id))
        if existing:
            return existing
        raise
    await db.refresh(prefs)
    return prefs


@router.get(
    "/preferences",
    response_model=AudioPreferencesOut,
    summary="Get audio preferences",
    description="Returns current user's audio playback preferences.",
)
@cache_response("audio_preferences", ttl=90)
async def get_audio_preferences(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> AudioPreferencesOut:
    prefs = await _get_or_create_prefs(db, current_user.id)
    return AudioPreferencesOut(
        user_id=prefs.user_id,
        volume=prefs.volume,
        updated_at=prefs.updated_at,
    )


@router.put(
    "/preferences",
    response_model=AudioPreferencesOut,
    summary="Update audio preferences",
    description="Persists current user's playback preferences (volume).",
)
async def update_audio_preferences(
    payload: AudioPreferencesIn,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> AudioPreferencesOut:
    prefs = await _get_or_create_prefs(db, current_user.id)
    prefs.volume = payload.volume
    await db.commit()
    await db.refresh(prefs)
    await invalidate_user_endpoint_cache(
        current_user.id,
        key_prefix="audio_preferences",
        module=_AUDIO_MOD,
        function_name="get_audio_preferences",
    )
    return AudioPreferencesOut(
        user_id=prefs.user_id,
        volume=prefs.volume,
        updated_at=prefs.updated_at,
    )

