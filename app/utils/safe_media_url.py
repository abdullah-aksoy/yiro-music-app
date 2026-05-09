"""Allowlist for embedding GIF/sticker image URLs (chat + discover comments)."""

from urllib.parse import urlparse

_ALLOWED_HOST_SUFFIXES: tuple[str, ...] = (
    "giphy.com",
    "tenor.com",
    "discordapp.com",
    "discordapp.net",
    "discord.com",
)


def is_safe_sticker_url(url: str) -> bool:
    raw = (url or "").strip()
    if not raw or len(raw) > 2048:
        return False
    try:
        u = urlparse(raw)
    except Exception:
        return False
    if u.scheme != "https":
        return False
    host = (u.hostname or "").lower()
    if not host:
        return False
    return any(host == s or host.endswith("." + s) for s in _ALLOWED_HOST_SUFFIXES)
