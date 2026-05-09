"""Shared URL / token charset checks (Listen Together session ids, etc.)."""

import re

# Aligned with frontend `urlSafe.sanitizeListenTogetherJoinId` (UUID + similar ids).
LISTEN_SESSION_ID_RE = re.compile(r"^[a-zA-Z0-9_.-]{4,128}$")


def is_safe_listen_session_id(value: str | None) -> bool:
    if not value or not isinstance(value, str):
        return False
    return bool(LISTEN_SESSION_ID_RE.fullmatch(value.strip()))
