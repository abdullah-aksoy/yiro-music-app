"""HTTP guards: auth rate limits and max request body (Content-Length)."""

from __future__ import annotations

import time
from collections import defaultdict
from collections.abc import Awaitable, Callable

from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp

from app.config import get_settings
from app.utils.input_limits import HTTP_MAX_CONTENT_LENGTH_BYTES

# (ip, bucket) -> list of unix timestamps
_rate_hits: dict[tuple[str, str], list[float]] = defaultdict(list)


def _client_ip(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip() or "unknown"
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


def _prune_and_count(timestamps: list[float], window_sec: float, now: float) -> int:
    cutoff = now - window_sec
    while timestamps and timestamps[0] < cutoff:
        timestamps.pop(0)
    return len(timestamps)


def _auth_rate_buckets(api_prefix: str) -> list[tuple[str, str, float, int]]:
    """(path suffix match, rate bucket name, window_sec, max_hits)."""
    p = api_prefix.rstrip("/")
    return [
        (f"{p}/auth/register", "auth_register", 3600.0, 20),
        (f"{p}/auth/login", "auth_login", 60.0, 40),
        (f"{p}/auth/token", "auth_login", 60.0, 40),
        (f"{p}/auth/forgot-password", "auth_forgot", 3600.0, 12),
    ]


class AuthRateLimitMiddleware(BaseHTTPMiddleware):
    """Sliding-window rate limit for unauthenticated auth POST endpoints (per client IP)."""

    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)
        self._settings = get_settings()
        self._rules = _auth_rate_buckets(self._settings.api_prefix)

    async def dispatch(self, request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        if request.method != "POST":
            return await call_next(request)

        path = request.url.path.rstrip("/") or "/"
        rule = next((r for r in self._rules if path == r[0].rstrip("/")), None)
        if not rule:
            return await call_next(request)

        _, bucket, window_sec, max_hits = rule
        ip = _client_ip(request)
        key = (ip, bucket)
        now = time.monotonic()
        ts_list = _rate_hits[key]
        count = _prune_and_count(ts_list, window_sec, now)
        if count >= max_hits:
            return JSONResponse(
                status_code=429,
                content={"detail": "Too many requests. Try again later."},
                headers={"Retry-After": str(int(window_sec))},
            )
        ts_list.append(now)
        return await call_next(request)


class MaxBodySizeMiddleware(BaseHTTPMiddleware):
    """Reject oversized bodies when Content-Length is present (typical JSON / form posts)."""

    def __init__(self, app: ASGIApp, *, max_bytes: int = HTTP_MAX_CONTENT_LENGTH_BYTES) -> None:
        super().__init__(app)
        self._max = max_bytes

    async def dispatch(self, request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        if request.method not in ("POST", "PUT", "PATCH", "DELETE"):
            return await call_next(request)
        cl = request.headers.get("content-length")
        if not cl:
            return await call_next(request)
        try:
            n = int(cl)
        except ValueError:
            return await call_next(request)
        if n > self._max:
            return JSONResponse(
                status_code=413,
                content={"detail": f"Request body too large (max {self._max} bytes)."},
            )
        return await call_next(request)
