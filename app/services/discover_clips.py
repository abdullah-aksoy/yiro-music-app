"""Discover catalog from app/static/videos/discover-clips.json (served at /ui/videos/).

Each item: id, artist_name, title, file (mp4 filename). Optional HLS:
  - \"hls\": \"clip.m3u8\" — same base as mp4 (empty discover_video_base_url => /ui/videos/)
  - \"hls_url\": \"https://...\" — absolute master URL
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from app.config import Settings

logger = logging.getLogger(__name__)

_CLIPS_PATH = Path(__file__).resolve().parent.parent / "static" / "videos" / "discover-clips.json"


def discover_clips_file_exists() -> bool:
    return _CLIPS_PATH.is_file()


def load_discover_clip_catalog() -> list[dict[str, Any]]:
    if not _CLIPS_PATH.is_file():
        return []
    try:
        raw = _CLIPS_PATH.read_text(encoding="utf-8")
        data = json.loads(raw)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        logger.warning("discover-clips.json unreadable: %s", exc)
        return []
    if isinstance(data, dict) and "clips" in data:
        data = data["clips"]
    if not isinstance(data, list):
        return []
    out: list[dict[str, Any]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        try:
            sid = int(item["id"])
        except (KeyError, TypeError, ValueError):
            continue
        artist = str(item.get("artist_name", "")).strip()
        title = str(item.get("title", "")).strip()
        file_key = str(item.get("file", "")).strip()
        if not artist or not title or not file_key:
            continue
        sort_order = item.get("sort_order", 0)
        try:
            sort_order = int(sort_order)
        except (TypeError, ValueError):
            sort_order = 0
        entry: dict[str, Any] = {
            "id": sid,
            "artist_name": artist,
            "title": title,
            "file": file_key,
            "sort_order": sort_order,
        }
        itunes = item.get("itunes_track_id")
        if itunes is not None:
            try:
                entry["itunes_track_id"] = int(itunes)
            except (TypeError, ValueError):
                pass
        hu = item.get("hls_url")
        if isinstance(hu, str) and hu.strip().lower().startswith(("http://", "https://")):
            entry["hls_url"] = hu.strip()
        elif item.get("hls"):
            entry["hls_file"] = str(item["hls"]).strip()
        out.append(entry)
    out.sort(key=lambda x: (x["sort_order"], x["id"]))
    return out


def clip_video_url(settings: Settings, filename: str) -> str:
    fn = filename.strip().replace("\\", "/").lstrip("/")
    parts = [p for p in fn.split("/") if p]
    if not parts or ".." in parts:
        raise ValueError("invalid clip filename")
    base = settings.discover_video_base_url.strip().rstrip("/")
    if base:
        return f"{base}/{fn}"
    return f"/ui/videos/{fn}"
