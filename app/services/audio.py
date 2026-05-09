from pathlib import Path

from app.config import get_settings

settings = get_settings()


def parse_range_header(range_header: str | None, file_size: int) -> tuple[int, int, bool]:
    if file_size <= 0:
        raise ValueError("Empty file")
    if not range_header:
        return 0, file_size - 1, False
    if not range_header.startswith("bytes="):
        raise ValueError("Invalid range unit")

    byte_range = range_header.replace("bytes=", "", 1).strip()
    if "," in byte_range:
        raise ValueError("Multiple ranges are not supported")
    if "-" not in byte_range:
        raise ValueError("Invalid range format")

    start_str, end_str = byte_range.split("-", 1)

    if start_str == "" and end_str == "":
        raise ValueError("Invalid range")
    if start_str == "":
        # RFC suffix-byte-range-spec: "bytes=-N" means last N bytes.
        suffix_length = int(end_str)
        if suffix_length <= 0:
            raise ValueError("Invalid range")
        if suffix_length >= file_size:
            return 0, file_size - 1, True
        return file_size - suffix_length, file_size - 1, True

    start = int(start_str)
    end = int(end_str) if end_str else file_size - 1

    if start < 0 or end < 0 or start > end or start >= file_size or end >= file_size:
        raise ValueError("Invalid range")
    return start, end, True


def resolve_music_path(file_path: str) -> Path:
    normalized_path = validate_local_file_path(file_path)
    resolved = (get_music_root() / normalized_path).resolve()
    try:
        resolved.relative_to(get_music_root())
    except ValueError as exc:
        raise ValueError("Audio file path escapes music directory") from exc

    if not resolved.exists():
        raise FileNotFoundError(f"Audio file not found: {file_path}")
    return resolved


def get_project_root() -> Path:
    return Path(__file__).resolve().parents[2]


def get_music_root() -> Path:
    return (get_project_root() / settings.music_dir).resolve()


def validate_local_file_path(file_path: str | None) -> str:
    raw = (file_path or "").strip().replace("\\", "/")
    if not raw:
        raise ValueError("file_path is required for local songs")
    candidate = Path(raw)
    if candidate.is_absolute():
        raise ValueError("Absolute file_path is not allowed")
    normalized = candidate.as_posix()
    if normalized.startswith("../") or "/../" in normalized or normalized == "..":
        raise ValueError("Parent directory traversal is not allowed")
    if normalized.startswith("./"):
        normalized = normalized[2:]
    if normalized == "" or normalized.startswith("/"):
        raise ValueError("Invalid local file_path")
    return normalized

