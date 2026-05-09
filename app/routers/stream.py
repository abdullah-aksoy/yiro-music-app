from collections.abc import Iterator
import mimetypes

from fastapi import APIRouter, Depends, Header, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.song import Song
from app.services.audio import parse_range_header, resolve_music_path
from app.utils.deps import get_current_user_from_bearer_or_query

router = APIRouter(prefix="/stream", tags=["stream"])


@router.get(
    "/{song_id}",
    summary="Stream song",
    description="Streams local audio file with byte-range support. (Lokal dosyadan byte-range destekli stream yapar.)",
)
async def stream_song(
    song_id: int,
    range_header: str | None = Header(default=None, alias="Range", max_length=128),
    db: AsyncSession = Depends(get_db),
    _: object = Depends(get_current_user_from_bearer_or_query),
) -> StreamingResponse:
    song = await db.scalar(select(Song).where(Song.id == song_id))
    if not song:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Song not found")
    if not song.file_path:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Song has no local file path for streaming",
        )

    try:
        path = resolve_music_path(song.file_path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    file_size = path.stat().st_size
    try:
        start, end, is_partial = parse_range_header(range_header, file_size)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_416_REQUESTED_RANGE_NOT_SATISFIABLE,
            detail=str(exc),
            headers={"Content-Range": f"bytes */{file_size}"},
        ) from exc

    chunk_size = 1024 * 64
    content_length = end - start + 1

    def iter_bytes() -> Iterator[bytes]:
        with path.open("rb") as file:
            file.seek(start)
            remaining = content_length
            while remaining > 0:
                chunk = file.read(min(chunk_size, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    media_type = mimetypes.guess_type(path.name)[0] or "audio/mpeg"
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(content_length),
        "Content-Type": media_type,
    }
    status_code = status.HTTP_200_OK
    if is_partial:
        headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"
        status_code = status.HTTP_206_PARTIAL_CONTENT

    return StreamingResponse(iter_bytes(), status_code=status_code, headers=headers, media_type=media_type)

