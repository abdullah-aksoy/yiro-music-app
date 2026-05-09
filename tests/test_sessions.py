import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.user import User
from app.utils.auth import create_access_token
from app.utils.redis_client import RedisClient
from app.utils.session_manager import session_manager

client = TestClient(app)


@pytest.fixture(autouse=True)
def _sessions_without_redis(monkeypatch: pytest.MonkeyPatch) -> None:
    """Avoid cross-event-loop reuse of the global async Redis client."""
    monkeypatch.setattr(RedisClient, "get_client", lambda: None)


class _FakeAsyncSessionCM:
    def __init__(self, db: MagicMock) -> None:
        self._db = db

    async def __aenter__(self) -> MagicMock:
        return self._db

    async def __aexit__(self, *args: object) -> None:
        return None


def _patch_db_user1() -> MagicMock:
    db = MagicMock()
    user = MagicMock(spec=User)
    user.id = 1
    user.username = "testhost"
    user.avatar_url = None
    db.get = AsyncMock(return_value=user)
    return patch("app.database.SessionLocal", return_value=_FakeAsyncSessionCM(db))


async def _create_and_resolve_session() -> None:
    session_id = await session_manager.create_session(host_id=1)
    assert session_id is not None
    assert isinstance(session_id, str)
    assert await session_manager.get_session(session_id) is not None


def test_create_session():
    asyncio.run(_create_and_resolve_session())


def _drain_initial_ws_messages(ws) -> None:
    msg = ws.receive_json()
    assert msg["type"] == "SYNC"
    msg = ws.receive_json()
    assert msg["type"] == "CHAT_HISTORY"


def test_websocket_sync():
    session_id = asyncio.run(session_manager.create_session(host_id=1))
    token = create_access_token("1")
    url = f"/api/sessions/ws/{session_id}?token={token}"
    with _patch_db_user1():
        with client.websocket_connect(url) as websocket:
            _drain_initial_ws_messages(websocket)

            websocket.send_json(
                {
                    "type": "STATE_UPDATE",
                    "state": {"song_id": 123, "is_playing": True},
                }
            )

            with client.websocket_connect(url) as websocket2:
                _drain_initial_ws_messages(websocket2)
                websocket.send_json(
                    {
                        "type": "STATE_UPDATE",
                        "state": {"song_id": 456},
                    }
                )
                data2 = websocket2.receive_json()
                assert data2["type"] == "SYNC"
                assert data2["state"]["song_id"] == 456
