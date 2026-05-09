import functools
import hashlib
import json
import logging
from collections.abc import Callable
from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import Any

from pydantic import BaseModel
from sqlalchemy import inspect as sa_inspect

from app.utils.redis_client import RedisClient

logger = logging.getLogger(__name__)

_SKIP_CACHE_KWARGS = frozenset({"db"})


LIBRARY_ROUTER_MODULE = "app.routers.library"


def user_scoped_cache_key(key_prefix: str, module: str, function_name: str, user_id: int) -> str:
    """Build the same key as _cache_key when kwargs only contain current_user (no extra params)."""
    parts = [key_prefix, module, function_name, f"uid={user_id}"]
    raw = ":".join(str(p) for p in parts)
    if len(raw) > 256:
        digest = hashlib.sha256(raw.encode()).hexdigest()
        raw = f"{key_prefix}:{function_name}:{digest}"
    return f"cache:{raw}"


async def invalidate_user_endpoint_cache(
    user_id: int,
    *,
    key_prefix: str,
    module: str,
    function_name: str,
) -> None:
    """Delete a single user-scoped GET cache entry (same key shape as @cache_response)."""
    redis = RedisClient.get_client()
    if not redis:
        return
    key = user_scoped_cache_key(key_prefix, module, function_name, user_id)
    try:
        await redis.delete(key)
    except Exception as exc:
        logger.debug("Cache delete skipped for %s: %s", key, exc)


async def invalidate_user_handler_cache_variants(
    user_id: int,
    *,
    key_prefix: str,
    module: str,
    function_name: str,
) -> None:
    """Delete all cached responses for this user and handler (any query-param key suffix)."""
    redis = RedisClient.get_client()
    if not redis:
        return
    pattern = f"cache:{key_prefix}:{module}:{function_name}:uid={user_id}*"
    try:
        batch: list[str] = []
        async for key in redis.scan_iter(match=pattern, count=200):
            batch.append(key)
            if len(batch) >= 128:
                await redis.delete(*batch)
                batch.clear()
        if batch:
            await redis.delete(*batch)
    except Exception as exc:
        logger.debug("Cache pattern invalidate skipped for %s: %s", pattern, exc)


async def invalidate_user_library_summary_stats_cache(user_id: int) -> None:
    """Drop Redis entries for GET /library/summary and /library/stats after mutations."""
    redis = RedisClient.get_client()
    if not redis:
        return
    mod = LIBRARY_ROUTER_MODULE
    keys = (
        user_scoped_cache_key("library_summary", mod, "get_library_summary", user_id),
        user_scoped_cache_key("library_stats", mod, "get_library_stats", user_id),
    )
    for key in keys:
        try:
            await redis.delete(key)
        except Exception as exc:
            logger.debug("Cache delete skipped for %s: %s", key, exc)


def _cache_key(prefix: str, func: Callable[..., Any], kwargs: dict[str, Any]) -> str:
    parts: list[str] = [prefix, func.__module__, func.__name__]
    user = kwargs.get("current_user")
    if user is not None:
        uid = getattr(user, "id", None)
        if uid is not None:
            parts.append(f"uid={uid}")
    for key in sorted(k for k in kwargs if k not in _SKIP_CACHE_KWARGS and k != "current_user"):
        parts.append(f"{key}={kwargs[key]}")
    raw = ":".join(str(p) for p in parts)
    if len(raw) > 256:
        digest = hashlib.sha256(raw.encode()).hexdigest()
        raw = f"{prefix}:{func.__name__}:{digest}"
    return f"cache:{raw}"


def _to_jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json")
    if isinstance(value, list):
        return [_to_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {str(k): _to_jsonable(v) for k, v in value.items()}
    try:
        insp = sa_inspect(value)
        if getattr(insp, "mapper", None) is not None:
            out: dict[str, Any] = {}
            for col in insp.mapper.column_attrs:
                out[col.key] = _to_jsonable(getattr(value, col.key))
            return out
    except Exception:
        pass
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable for cache")


def _dumps_result(result: Any) -> str:
    return json.dumps(_to_jsonable(result))


def cache_response(key_prefix: str, ttl: int = 3600) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(func)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            redis = RedisClient.get_client()
            if not redis:
                return await func(*args, **kwargs)

            cache_key = _cache_key(key_prefix, func, kwargs)

            try:
                cached_data = await redis.get(cache_key)
                if cached_data:
                    return json.loads(cached_data)
            except Exception as e:
                logger.error("Cache get error: %s", e)

            result = await func(*args, **kwargs)

            try:
                await redis.setex(cache_key, ttl, _dumps_result(result))
            except TypeError as e:
                logger.warning("Cache skip (not serializable): %s", e)
            except Exception as e:
                logger.error("Cache set error: %s", e)

            return result

        return wrapper

    return decorator
