import logging
import uuid
import json
from datetime import datetime

import redis.exceptions
from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect, HTTPException, status
from app.utils.deps import get_current_user
from app.models.user import User
from app.utils.session_manager import session_manager
from app.utils.redis_client import RedisClient
from app.utils.input_limits import LISTEN_WS_VOICE_CONTENT_MAX
from app.utils.safe_media_url import is_safe_sticker_url
from app.utils.url_safe import is_safe_listen_session_id
from typing import Optional

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/sessions", tags=["sessions"])

@router.post("/create")
async def create_session(current_user: User = Depends(get_current_user)):
    try:
        session_id = await session_manager.create_session(current_user.id)
    except redis.exceptions.RedisError as exc:
        logger.exception("sessions/create Redis error user_id=%s", current_user.id)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Listen Together session store (Redis) is unavailable. Check REDIS_URL and region/network.",
        ) from exc
    except Exception as exc:
        logger.exception("sessions/create failed user_id=%s", current_user.id)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Could not create session.",
        ) from exc
    return {"session_id": session_id}

@router.websocket("/ws/{session_id}")
async def session_websocket(websocket: WebSocket, session_id: str):
    await websocket.accept()

    if not is_safe_listen_session_id(session_id):
        await websocket.close(code=1008)
        return

    session = await session_manager.get_session(session_id)
    if not session:
        await websocket.close(code=1008)
        return

    from app.utils.auth import decode_token
    from app.database import SessionLocal
    from app.models.user import User
    
    token = websocket.query_params.get("token")
    user = None
    if token:
        try:
            user_id = decode_token(token)
            if user_id:
                if await session_manager.is_user_banned(int(user_id)):
                    remaining = await session_manager.get_remaining_penalty(int(user_id))
                    await websocket.close(code=1008, reason=f"Banned for {remaining}m")
                    return

                async with SessionLocal() as db:
                    user = await db.get(User, int(user_id))
        except Exception as e:
            logger.error(f"Auth error in WS: {e}")

    conn_id = id(websocket)
    
    # Save participant metadata to Redis for global visibility
    redis = RedisClient.get_client()
    participant_meta = {
        "conn_id": conn_id,
        "user_id": user.id if user else None,
        "username": user.username if user else "Anonymous",
        "avatar_url": user.avatar_url if user else None,
    }
    if redis:
        await redis.hset(
            f"session:{session_id}:participants_meta",
            str(conn_id),
            json.dumps(participant_meta),
        )
    
    # Add to local participants for this worker
    session.local_participants[conn_id] = {"ws": websocket, "user": user}
    
    try:
        await session.broadcast_participant_list()

        current_state = await session.get_state()
        await websocket.send_json({
            "type": "SYNC",
            "state": current_state,
            "host_id": session.host_id,
            "conn_id": conn_id
        })
        
        history = await session.get_chat_history()
        await websocket.send_json({
            "type": "CHAT_HISTORY",
            "messages": history
        })

        while True:
            data = await websocket.receive_json()
            
            if data.get("type") == "STATE_UPDATE":
                if user and user.id == session.host_id:
                    state = await session.get_state()
                    state.update(data["state"])
                    await session.set_state(state)
                    await session.publish(
                        {
                            "type": "SYNC",
                            "state": state,
                        },
                        exclude_conn_id=conn_id,
                    )
                else:
                    logger.warning(
                        "STATE_UPDATE ignored session_id=%s conn_user_id=%s host_id=%s",
                        session_id,
                        user.id if user else None,
                        session.host_id,
                    )
            
            elif data.get("type") == "KICK" and user and user.id == session.host_id:
                try:
                    target_conn_id = int(data.get("conn_id"))
                    # If target is on this worker, close it directly
                    if target_conn_id in session.local_participants:
                        p_info = session.local_participants[target_conn_id]
                        if p_info.get("user"):
                            await session_manager.add_kick_penalty(p_info["user"].id)
                        await p_info["ws"].close(code=1008, reason="Kicked by host")
                    else:
                        # If target is on another worker, we could use a Pub/Sub message for KICK
                        await session.publish({
                            "type": "REMOTE_KICK",
                            "target_conn_id": target_conn_id
                        })
                except (ValueError, TypeError):
                    pass

            elif data.get("type") == "CHAT_MESSAGE":
                muted_users = await session.get_muted_users()
                if user and user.id not in muted_users:
                    subtype = data.get("subtype", "text")
                    content = data.get("content", "")
                    if subtype == "text":
                        content = str(content)[:1000]
                    elif subtype == "sticker":
                        content = str(content).strip()[:2000]
                        if not is_safe_sticker_url(content):
                            continue
                    else:
                        if len(str(content)) > LISTEN_WS_VOICE_CONTENT_MAX:
                            content = "Voice message too long"
                            subtype = "text"

                    msg = {
                        "type": "CHAT_MESSAGE",
                        "subtype": subtype,
                        "message_id": str(uuid.uuid4()),
                        "user_id": user.id,
                        "username": user.username,
                        "avatar_url": user.avatar_url,
                        "content": content,
                        "timestamp": datetime.now().isoformat()
                    }
                    await session.add_chat_message(msg)
                    await session.publish(msg)

            elif data.get("type") == "MUTE_USER" and user and user.id == session.host_id:
                try:
                    target_user_id = int(data.get("user_id"))
                    await session.add_muted_user(target_user_id)
                    await session.broadcast_participant_list()
                    await session.publish({"type": "MUTE_UPDATE"})
                except (ValueError, TypeError):
                    pass

            elif data.get("type") == "UNMUTE_USER" and user and user.id == session.host_id:
                try:
                    target_user_id = int(data.get("user_id"))
                    await session.remove_muted_user(target_user_id)
                    await session.broadcast_participant_list()
                    await session.publish({"type": "MUTE_UPDATE"})
                except (ValueError, TypeError):
                    pass

            elif data.get("type") == "DELETE_MESSAGE" and user and user.id == session.host_id:
                message_id = data.get("message_id")
                if message_id:
                    # In Redis list, deletion is harder by ID. 
                    # For simplicity, we just broadcast the deletion event to clients.
                    await session.publish({"type": "DELETE_MESSAGE", "message_id": message_id})

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error(f"WS Error: {e}")
    finally:
        # Cleanup
        if conn_id in session.local_participants:
            del session.local_participants[conn_id]
        
        redis = RedisClient.get_client()
        if redis:
            await redis.hdel(f"session:{session_id}:participants_meta", str(conn_id))

        await session.broadcast_participant_list()
