import redis.asyncio as redis
from app.config import get_settings

settings = get_settings()

class RedisClient:
    _instance = None
    _client = None

    @classmethod
    def get_client(cls):
        if cls._client is None:
            if not settings.redis_url:
                return None
            cls._client = redis.from_url(settings.redis_url, decode_responses=True)
        return cls._client

async def get_redis():
    return RedisClient.get_client()
