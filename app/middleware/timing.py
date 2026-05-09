"""Request duration logging for performance triage."""

import logging
import time
from collections.abc import Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from app.config import get_settings

logger = logging.getLogger("app.request_timing")


class RequestTimingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        start = time.perf_counter()
        response = await call_next(request)
        elapsed_ms = (time.perf_counter() - start) * 1000
        path = request.url.path
        method = request.method
        status = response.status_code
        msg = f"{method} {path} status={status} duration_ms={elapsed_ms:.1f}"
        slow_ms = get_settings().slow_request_ms
        if elapsed_ms >= slow_ms:
            logger.warning("slow_request %s", msg)
        else:
            logger.debug("request %s", msg)
        return response
