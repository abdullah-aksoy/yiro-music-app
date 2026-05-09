import argparse
import asyncio
import json
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from app.database import SessionLocal
from app.models.song import Song


TARGET_URLS = [
    "https://aksoyshop.com/aksam-gunesi.mp3",
    "https://aksoyshop.com/degismene-ragmen.mp3",
    "https://aksoyshop.com/dertler-benim-olsun.mp3",
    "https://aksoyshop.com/git.mp3",
    "https://aksoyshop.com/hasret-ruzgarlari.mp3",
    "https://aksoyshop.com/kaderimin-oyunu.mp3",
    "https://aksoyshop.com/kusura-bakma.mp3",
    "https://aksoyshop.com/napiyosun-mesela.mp3",
    "https://aksoyshop.com/sevmeyi-denemedin.mp3",
    "https://aksoyshop.com/sonen-sigaralar.mp3",
    "https://aksoyshop.com/vazgec-gonlum.mp3",
]


CHAR_REPLACEMENTS = str.maketrans(
    {
        "ı": "i",
        "İ": "i",
        "ş": "s",
        "Ş": "s",
        "ğ": "g",
        "Ğ": "g",
        "ü": "u",
        "Ü": "u",
        "ö": "o",
        "Ö": "o",
        "ç": "c",
        "Ç": "c",
    }
)


def normalize_slug(value: str) -> str:
    text = (value or "").strip().translate(CHAR_REPLACEMENTS).lower()
    text = re.sub(r"\((official|music|video|lyrics?|audio).*?\)", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"\[(official|music|video|lyrics?|audio).*?\]", " ", text, flags=re.IGNORECASE)
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")


def slug_from_url(url: str) -> str:
    stem = Path(url).stem
    return normalize_slug(stem)


def build_url_map() -> dict[str, str]:
    mapping: dict[str, str] = {}
    for url in TARGET_URLS:
        slug = slug_from_url(url)
        if slug:
            mapping[slug] = url
    return mapping


async def run_update(dry_run: bool) -> dict:
    url_map = build_url_map()
    report: dict = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "dry_run": dry_run,
        "targets_total": len(url_map),
        "updated": [],
        "unchanged": [],
        "missing": [],
        "ambiguous": [],
    }

    async with SessionLocal() as db:
        songs = list((await db.execute(select(Song))).scalars().all())
        songs_by_slug: dict[str, list[Song]] = {}
        for song in songs:
            slug = normalize_slug(song.title or "")
            if not slug:
                continue
            songs_by_slug.setdefault(slug, []).append(song)

        for slug, url in url_map.items():
            matches = songs_by_slug.get(slug, [])
            if not matches:
                report["missing"].append({"slug": slug, "url": url})
                continue
            if len(matches) > 1:
                report["ambiguous"].append(
                    {
                        "slug": slug,
                        "url": url,
                        "matches": [
                            {
                                "id": song.id,
                                "title": song.title,
                                "artist": song.artist,
                                "is_local": song.is_local,
                                "file_path": song.file_path,
                                "preview_url": song.preview_url,
                            }
                            for song in matches
                        ],
                    }
                )
                continue

            song = matches[0]
            changed = (
                song.preview_url != url
                or song.file_path is not None
                or song.is_local is not False
            )
            entry = {
                "slug": slug,
                "song_id": song.id,
                "title": song.title,
                "artist": song.artist,
                "old_preview_url": song.preview_url,
                "new_preview_url": url,
                "old_file_path": song.file_path,
                "new_file_path": None,
                "old_is_local": song.is_local,
                "new_is_local": False,
            }
            if not changed:
                report["unchanged"].append(entry)
                continue

            report["updated"].append(entry)
            if not dry_run:
                song.preview_url = url
                song.file_path = None
                song.is_local = False

        if dry_run:
            await db.rollback()
        else:
            await db.commit()

    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Replace local song streaming sources with aksoyshop remote MP3 URLs."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview changes without committing to database.",
    )
    parser.add_argument(
        "--report-path",
        type=str,
        default="scripts/update_song_stream_urls_report.json",
        help="Output JSON report path.",
    )
    return parser.parse_args()


async def main() -> None:
    args = parse_args()
    report = await run_update(dry_run=args.dry_run)
    report_path = Path(args.report_path)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(
        f"URL update completed. dry_run={report['dry_run']} updated={len(report['updated'])} "
        f"unchanged={len(report['unchanged'])} missing={len(report['missing'])} ambiguous={len(report['ambiguous'])}"
    )
    print(f"Report: {report_path}")


if __name__ == "__main__":
    asyncio.run(main())
