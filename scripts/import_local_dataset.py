import argparse
import asyncio
import csv
import difflib
import json
import re
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import select

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from app.database import SessionLocal
from app.models.song import Song
from app.services.audio import get_music_root, validate_local_file_path
from app.services.itunes import itunes_service

try:
    from mutagen import File as MutagenFile
except Exception:  # pragma: no cover - optional dependency fallback
    MutagenFile = None


AUDIO_EXTENSIONS = {".mp3", ".m4a", ".wav", ".flac", ".ogg", ".aac"}


@dataclass
class TrackInput:
    file_path: str
    title: str
    artist: str
    album: str | None
    genre: str | None
    duration_ms: int | None
    source_url: str | None
    license_type: str | None
    license_url: str | None
    attribution: str | None


def normalize_text(value: str | None) -> str:
    raw = (value or "").strip().lower()
    raw = unicodedata.normalize("NFKD", raw)
    raw = "".join(ch for ch in raw if not unicodedata.combining(ch))
    # Remove common upload/video suffixes to improve matching quality.
    cleaned = re.sub(r"\s*\((official|lyrics?|audio|video).*?\)\s*", " ", raw, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*\[(official|lyrics?|audio|video).*?\]\s*", " ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"[^a-z0-9\s]+", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def is_unknown_artist(value: str | None) -> bool:
    return normalize_text(value) in {"", "unknown"}


def similarity(left: str, right: str) -> float:
    if not left or not right:
        return 0.0
    if left == right:
        return 1.0
    return difflib.SequenceMatcher(a=left, b=right).ratio()


def extract_itunes_artwork_url(meta: dict[str, Any] | None) -> str | None:
    if not meta:
        return None
    raw = (
        meta.get("artworkUrl100")
        or meta.get("artworkUrl60")
        or meta.get("artworkUrl30")
        or meta.get("artwork_url")
    )
    if not raw:
        return None
    value = str(raw).strip()
    if not value:
        return None
    # Prefer larger cover when iTunes returns size-tagged URL.
    return value.replace("100x100bb", "600x600bb").replace("60x60bb", "600x600bb")


def parse_name_fallback(path: Path) -> tuple[str, str]:
    base = path.stem
    if " - " in base:
        left, right = [part.strip() for part in base.split(" - ", 1)]
        # Default convention is artist - title.
        artist, title = left, right
        # Flip only when right side clearly looks like an artist token (e.g. BLOK3).
        if right and right.isupper():
            artist, title = right, left
        return title.strip() or "Unknown", artist.strip() or "Unknown"
    return base.strip() or "Unknown", "Unknown"


def read_duration_ms(path: Path) -> int | None:
    if MutagenFile is None:
        return None
    try:
        audio = MutagenFile(path)
        if not audio or not getattr(audio, "info", None):
            return None
        length = getattr(audio.info, "length", None)
        if length is None:
            return None
        return int(float(length) * 1000)
    except Exception:
        return None


def load_manifest_rows(manifest_csv: Path | None) -> dict[str, dict[str, str]]:
    if not manifest_csv:
        return {}
    if not manifest_csv.exists():
        raise FileNotFoundError(f"Manifest file not found: {manifest_csv}")
    rows: dict[str, dict[str, str]] = {}
    with manifest_csv.open("r", encoding="utf-8-sig", newline="") as fp:
        reader = csv.DictReader(fp)
        for row in reader:
            rel = (row.get("relative_path") or "").strip()
            if not rel:
                continue
            key = rel.replace("\\", "/").lstrip("./")
            rows[key] = row
    return rows


def build_track_input(path: Path, music_root: Path, manifest_row: dict[str, str] | None) -> TrackInput:
    rel_path = path.resolve().relative_to(music_root).as_posix()
    safe_file_path = validate_local_file_path(rel_path)
    fallback_title, fallback_artist = parse_name_fallback(path)
    duration_value = (manifest_row or {}).get("duration_ms")
    duration_ms = int(duration_value) if duration_value and duration_value.isdigit() else read_duration_ms(path)
    return TrackInput(
        file_path=safe_file_path,
        title=((manifest_row or {}).get("title") or fallback_title).strip(),
        artist=((manifest_row or {}).get("artist") or fallback_artist).strip(),
        album=((manifest_row or {}).get("album") or "").strip() or None,
        genre=((manifest_row or {}).get("genre") or "").strip() or None,
        duration_ms=duration_ms,
        source_url=((manifest_row or {}).get("source_url") or "").strip() or None,
        license_type=((manifest_row or {}).get("license_type") or "").strip() or None,
        license_url=((manifest_row or {}).get("license_url") or "").strip() or None,
        attribution=((manifest_row or {}).get("attribution") or "").strip() or None,
    )


def pick_itunes_match(candidates: list[dict[str, Any]], title: str, artist: str) -> dict[str, Any] | None:
    if not candidates:
        return None
    norm_title = normalize_text(title)
    norm_artist = normalize_text(artist)
    unknown_artist = is_unknown_artist(artist)
    best_item: dict[str, Any] | None = None
    best_score = 0.0
    for item in candidates:
        item_title = normalize_text(item.get("trackName") or item.get("collectionName"))
        item_artist = normalize_text(item.get("artistName"))
        title_score = similarity(norm_title, item_title)
        if title_score < 0.55:
            continue
        artist_score = 0.0 if unknown_artist else similarity(norm_artist, item_artist)
        score = title_score if unknown_artist else (0.7 * title_score + 0.3 * artist_score)
        if score > best_score:
            best_score = score
            best_item = item

    if not best_item:
        return None
    threshold = 0.72 if unknown_artist else 0.75
    return best_item if best_score >= threshold else None


async def enrich_with_itunes(track: TrackInput) -> tuple[TrackInput, dict[str, Any] | None]:
    artist_value = (track.artist or "").strip()
    unknown_artist = is_unknown_artist(artist_value)
    primary_term = track.title.strip() if unknown_artist else f"{artist_value} {track.title}".strip()
    terms = [primary_term]
    if not unknown_artist:
        terms.append(track.title.strip())

    chosen = None
    for term in terms:
        try:
            candidates = await itunes_service.search_songs(term=term, limit=15)
        except Exception:
            continue
        chosen = pick_itunes_match(candidates, title=track.title, artist=track.artist)
        if chosen:
            break
    if not chosen:
        return track, None
    enriched = TrackInput(
        file_path=track.file_path,
        title=chosen.get("trackName") or track.title,
        artist=chosen.get("artistName") or track.artist,
        album=chosen.get("collectionName") or track.album,
        genre=chosen.get("primaryGenreName") or track.genre,
        duration_ms=chosen.get("trackTimeMillis") or track.duration_ms,
        source_url=track.source_url,
        license_type=track.license_type,
        license_url=track.license_url,
        attribution=track.attribution,
    )
    return enriched, chosen


async def upsert_track(db, track: TrackInput, itunes_meta: dict[str, Any] | None) -> str:
    existing = await db.scalar(select(Song).where(Song.file_path == track.file_path))
    if not existing and itunes_meta and itunes_meta.get("trackId"):
        existing = await db.scalar(select(Song).where(Song.itunes_track_id == str(itunes_meta.get("trackId"))))

    artwork_url = extract_itunes_artwork_url(itunes_meta)
    payload = {
        "title": track.title,
        "artist": track.artist,
        "album": track.album,
        "genre": track.genre,
        "duration_ms": track.duration_ms,
        "file_path": track.file_path,
        "is_local": True,
        "artwork_url": artwork_url,
        "preview_url": itunes_meta.get("previewUrl") if itunes_meta else None,
        "itunes_track_id": str(itunes_meta.get("trackId")) if itunes_meta and itunes_meta.get("trackId") else None,
    }

    if existing:
        for key, value in payload.items():
            # Never wipe existing iTunes metadata when enrichment has no match.
            if key in {"artwork_url", "preview_url", "itunes_track_id"} and value is None:
                continue
            if value is not None:
                setattr(existing, key, value)
        return "updated"

    db.add(Song(**payload))
    return "created"


async def run_import(args: argparse.Namespace) -> dict[str, Any]:
    music_root = get_music_root()
    audio_dir = Path(args.audio_dir).resolve() if args.audio_dir else music_root
    try:
        audio_dir.relative_to(music_root)
    except ValueError as exc:
        raise ValueError(f"audio-dir must be inside music root: {music_root}") from exc

    manifest = load_manifest_rows(Path(args.manifest_csv).resolve() if args.manifest_csv else None)
    files = sorted(
        [
            path
            for path in audio_dir.rglob("*")
            if path.is_file() and path.suffix.lower() in AUDIO_EXTENSIONS
        ]
    )

    report: dict[str, Any] = {
        "audio_dir": str(audio_dir),
        "music_root": str(music_root),
        "dry_run": args.dry_run,
        "itunes_enrich": args.itunes_enrich,
        "files_scanned": len(files),
        "created": 0,
        "updated": 0,
        "skipped": 0,
        "errors": [],
        "items": [],
    }

    async with SessionLocal() as db:
        for file_path in files:
            manifest_key = file_path.resolve().relative_to(music_root).as_posix()
            manifest_row = manifest.get(manifest_key)
            try:
                track = build_track_input(file_path, music_root, manifest_row)
                itunes_meta = None
                if args.itunes_enrich:
                    track, itunes_meta = await enrich_with_itunes(track)
                async with db.begin_nested():
                    action = await upsert_track(db, track, itunes_meta)
                    await db.flush()
                report[action] += 1
                report["items"].append(
                    {
                        "file_path": track.file_path,
                        "action": action,
                        "title": track.title,
                        "artist": track.artist,
                        "license_type": track.license_type,
                        "source_url": track.source_url,
                    }
                )
            except Exception as exc:
                report["skipped"] += 1
                report["errors"].append({"file": str(file_path), "error": str(exc)})

        if args.dry_run:
            await db.rollback()
        else:
            try:
                await db.commit()
            except Exception as exc:
                await db.rollback()
                report["created"] = 0
                report["updated"] = 0
                report["items"] = []
                report["errors"].append(
                    {"file": "<commit>", "error": f"Commit failed, all changes rolled back: {exc}"}
                )

    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Import local legal song dataset into songs table.")
    parser.add_argument("--audio-dir", type=str, default=None, help="Audio directory inside configured music root.")
    parser.add_argument("--manifest-csv", type=str, default=None, help="Optional CSV with relative_path and metadata.")
    parser.add_argument("--itunes-enrich", action="store_true", help="Enrich title/artist metadata via iTunes search.")
    parser.add_argument("--dry-run", action="store_true", help="Validate and preview without committing DB changes.")
    parser.add_argument("--report-path", type=str, default="scripts/import_report.json", help="Where to write import report JSON.")
    return parser.parse_args()


async def main() -> None:
    args = parse_args()
    report = await run_import(args)
    report_path = Path(args.report_path)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=True), encoding="utf-8")
    print(
        f"Import completed. created={report['created']} updated={report['updated']} "
        f"skipped={report['skipped']} scanned={report['files_scanned']}"
    )
    print(f"Report: {report_path}")


if __name__ == "__main__":
    asyncio.run(main())
