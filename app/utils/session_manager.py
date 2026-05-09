import uuid
import json
import asyncio
from typing import Dict, Optional, Any, List
from fastapi import WebSocket
from datetime import datetime, timedelta
from app.utils.redis_client import RedisClient

class ListenSession:
    def __init__(self, session_id: str, host_id: int):
        self.session_id = session_id
        self.host_id = host_id
        # Local to this worker instance
        self.local_participants: Dict[int, Dict[str, Any]] = {}
        self.pubsub_task = None
        self._memory_state: Dict[str, Any] = {
            "song_id": None,
            "is_playing": False,
            "progress_ms": 0,
            "timestamp": None,
        }

    async def get_redis(self):
        return RedisClient.get_client()

    async def get_state(self) -> Dict[str, Any]:
        redis = await self.get_redis()
        if not redis:
            return dict(self._memory_state)
        data = await redis.get(f"session:{self.session_id}:state")
        return json.loads(data) if data else {
            "song_id": None,
            "is_playing": False,
            "progress_ms": 0,
            "timestamp": None
        }

    async def set_state(self, state: Dict[str, Any]):
        redis = await self.get_redis()
        if not redis:
            self._memory_state = state
            return
        await redis.set(f"session:{self.session_id}:state", json.dumps(state))

    async def get_muted_users(self) -> List[int]:
        redis = await self.get_redis()
        if not redis: return []
        data = await redis.smembers(f"session:{self.session_id}:muted")
        return [int(u) for u in data]

    async def add_muted_user(self, user_id: int):
        redis = await self.get_redis()
        if not redis: return
        await redis.sadd(f"session:{self.session_id}:muted", user_id)

    async def remove_muted_user(self, user_id: int):
        redis = await self.get_redis()
        if not redis: return
        await redis.srem(f"session:{self.session_id}:muted", user_id)

    async def get_chat_history(self) -> List[Dict[str, Any]]:
        redis = await self.get_redis()
        if not redis: return []
        data = await redis.lrange(f"session:{self.session_id}:chat", 0, -1)
        return [json.loads(d) for d in data]

    async def add_chat_message(self, msg: Dict[str, Any]):
        redis = await self.get_redis()
        if not redis: return
        await redis.rpush(f"session:{self.session_id}:chat", json.dumps(msg))
        await redis.ltrim(f"session:{self.session_id}:chat", -100, -1)

    async def publish(self, message: Dict[str, Any], exclude_conn_id: Optional[int] = None):
        redis = await self.get_redis()
        if not redis:
            await self.broadcast_local(message, exclude_conn_id=exclude_conn_id)
            return
        await redis.publish(f"session:{self.session_id}:channel", json.dumps(message))

    async def broadcast_local(self, message: Dict[str, Any], exclude_conn_id: Optional[int] = None):
        for conn_id, p_info in list(self.local_participants.items()):
            if conn_id != exclude_conn_id:
                try:
                    await p_info["ws"].send_json(message)
                except Exception:
                    pass

    async def start_listening(self):
        if self.pubsub_task:
            return
        self.pubsub_task = asyncio.create_task(self._listen_loop())

    async def _listen_loop(self):
        redis = await self.get_redis()
        if not redis: return
        pubsub = redis.pubsub()
        await pubsub.subscribe(f"session:{self.session_id}:channel")
        try:
            async for message in pubsub.listen():
                if message["type"] == "message":
                    data = json.loads(message["data"])
                    await self.broadcast_local(data)
        except Exception:
            pass
        finally:
            await pubsub.unsubscribe()

    async def broadcast_participant_list(self):
        # This is a bit tricky with multi-worker. Each worker should publish its local participants?
        # Better: store ALL participants in Redis.
        redis = await self.get_redis()
        if not redis: return
        
        # We need a way to track global participants.
        # Let's use a hash for global metadata about each participant.
        data = await redis.hgetall(f"session:{self.session_id}:participants_meta")
        participant_list = []
        for conn_id_str, meta_json in data.items():
            meta = json.loads(meta_json)
            # Add host/muted info
            muted_users = await self.get_muted_users()
            meta["is_host"] = meta.get("user_id") == self.host_id
            meta["is_muted"] = meta.get("user_id") in muted_users
            participant_list.append(meta)

        await self.publish({
            "type": "PARTICIPANT_LIST",
            "participants": participant_list
        })

class SessionManager:
    def __init__(self):
        # We still keep a small local cache of ListenSession objects for local participants management
        self.local_sessions: Dict[str, ListenSession] = {}

    async def get_redis(self):
        return RedisClient.get_client()

    async def is_user_banned(self, user_id: int) -> bool:
        redis = await self.get_redis()
        if not redis: return False
        penalty = await redis.get(f"penalty:{user_id}")
        if not penalty:
            return False
        return True

    async def get_remaining_penalty(self, user_id: int) -> int:
        redis = await self.get_redis()
        if not redis: return 0
        ttl = await redis.ttl(f"penalty:{user_id}")
        return max(0, int(ttl / 60))

    async def add_kick_penalty(self, user_id: int):
        redis = await self.get_redis()
        if not redis: return
        count_key = f"penalty_count:{user_id}"
        count = await redis.incr(count_key)
        await redis.expire(count_key, 86400) # Reset count after 24h
        
        minutes = count * 5
        await redis.setex(f"penalty:{user_id}", minutes * 60, "banned")

    async def create_session(self, host_id: int) -> str:
        redis = await self.get_redis()
        if not redis:
            session_id = str(uuid.uuid4())[:8]
            session = ListenSession(session_id, host_id)
            self.local_sessions[session_id] = session
            await session.start_listening()
            return session_id

        # If user already has a session, remove it
        old_sid = await redis.get(f"user_session:{host_id}")
        if old_sid:
            await self.remove_session(old_sid)
        
        session_id = str(uuid.uuid4())[:8]
        
        # Store metadata in Redis
        session_data = {"host_id": host_id, "created_at": datetime.now().isoformat()}
        await redis.set(f"session:{session_id}:meta", json.dumps(session_data))
        await redis.set(f"user_session:{host_id}", session_id)
        
        return session_id

    async def get_session(self, session_id: str) -> Optional[ListenSession]:
        if session_id in self.local_sessions:
            return self.local_sessions[session_id]
        
        redis = await self.get_redis()
        if not redis: return None
        
        meta_data = await redis.get(f"session:{session_id}:meta")
        if not meta_data:
            return None
        
        meta = json.loads(meta_data)
        session = ListenSession(session_id, meta["host_id"])
        self.local_sessions[session_id] = session
        await session.start_listening()
        return session

    async def remove_session(self, session_id: str):
        redis = await self.get_redis()
        if not redis:
            self.local_sessions.pop(session_id, None)
            return

        meta_data = await redis.get(f"session:{session_id}:meta")
        if meta_data:
            meta = json.loads(meta_data)
            await redis.delete(f"user_session:{meta['host_id']}")
        
        keys = (
            f"session:{session_id}:meta",
            f"session:{session_id}:state",
            f"session:{session_id}:muted",
            f"session:{session_id}:chat",
            f"session:{session_id}:participants_meta",
        )
        for key in keys:
            await redis.delete(key)
        # Publish session closure
        await redis.publish(f"session:{session_id}:channel", json.dumps({"type": "SESSION_CLOSED"}))
        
        if session_id in self.local_sessions:
            del self.local_sessions[session_id]

session_manager = SessionManager()
