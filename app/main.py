import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.requests import Request

from app.config import get_settings
from app.middleware.request_guards import AuthRateLimitMiddleware, MaxBodySizeMiddleware
from app.middleware.timing import RequestTimingMiddleware
from app.services.itunes import itunes_service
from app.utils.redis_client import RedisClient
from app.routers import (
    analytics,
    audio,
    auth,
    discover,
    favorites,
    history,
    library,
    notifications,
    playlists,
    queue,
    recommendations,
    search,
    sessions,
    social,
    songs,
    stream,
    sync,
    users_public,
)

settings = get_settings()


_log_redis = logging.getLogger("app.redis")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    redis = RedisClient.get_client()
    if redis:
        try:
            pong = await redis.ping()
            _log_redis.info("Redis connected (startup PING: %s)", pong)
        except Exception as exc:
            _log_redis.warning("Redis unreachable at startup (caching/session features degraded): %s", exc)
    else:
        _log_redis.info("REDIS_URL not set; response caching and session pub/sub use DB-only fallbacks where applicable")
    await itunes_service.startup()
    yield
    await itunes_service.shutdown()


app = FastAPI(
    title=settings.app_name,
    description=(
        "Spotify backend API. "
    ),
    debug=settings.debug,
    lifespan=lifespan,
)

app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(RequestTimingMiddleware)
app.add_middleware(MaxBodySizeMiddleware)
app.add_middleware(AuthRateLimitMiddleware)


@app.middleware("http")
async def discover_video_cache_headers(request: Request, call_next):
    """Long cache for Discover clips on Railway (same origin as /ui); avoids re-download on scroll."""
    response = await call_next(request)
    path = request.url.path
    if (
        path.startswith("/ui/videos/")
        and 200 <= response.status_code < 400
        and path.endswith((".mp4", ".webm", ".m4v"))
    ):
        response.headers["Cache-Control"] = "public, max-age=604800"
    return response

# CORS registered last so it wraps the stack as the outermost ASGI layer; responses (including many
# error paths) still get Access-Control-Allow-Origin when the browser sends a matching Origin.
_cors_kw: dict = {
    "allow_origins": settings.cors_allowed_origins(),
    "allow_credentials": True,
    "allow_methods": ["*"],
    "allow_headers": ["*"],
    "expose_headers": ["*"],
}
if settings.cors_allow_netlify_previews:
    _cors_kw["allow_origin_regex"] = r"https://[\w.-]+\.netlify\.app"
app.add_middleware(CORSMiddleware, **_cors_kw)

app.include_router(auth.router, prefix=settings.api_prefix)
app.include_router(discover.router, prefix=settings.api_prefix)
app.include_router(songs.router, prefix=settings.api_prefix)
app.include_router(search.router, prefix=settings.api_prefix)
app.include_router(stream.router, prefix=settings.api_prefix)
app.include_router(playlists.router, prefix=settings.api_prefix)
app.include_router(favorites.router, prefix=settings.api_prefix)
app.include_router(recommendations.router, prefix=settings.api_prefix)
app.include_router(history.router, prefix=settings.api_prefix)
app.include_router(library.router, prefix=settings.api_prefix)
app.include_router(analytics.router, prefix=settings.api_prefix)
app.include_router(sync.router, prefix=settings.api_prefix)
app.include_router(notifications.router, prefix=settings.api_prefix)
app.include_router(users_public.router, prefix=settings.api_prefix)
app.include_router(users_public.me_router, prefix=settings.api_prefix)
app.include_router(audio.router, prefix=settings.api_prefix)
app.include_router(queue.router, prefix=settings.api_prefix)
app.include_router(sessions.router, prefix=settings.api_prefix)
app.include_router(social.router, prefix=settings.api_prefix)

static_dir = Path(__file__).parent / "static"
app.mount("/ui", StaticFiles(directory=static_dir, html=True), name="ui")


@app.get("/")
async def root() -> dict[str, str]:
    return {"message": "Spotify Backend API is running"}

