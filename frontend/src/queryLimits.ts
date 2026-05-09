/**
 * Client-side limits aligned with FastAPI and `app/utils/input_limits.py`.
 * Keeps URLs bounded and matches server validation (422 if exceeded).
 */

/** `GET /search`, `GET /playlists/discover?q=` */
export const SEARCH_QUERY_MAX_LENGTH = 256;

/** `GET /history/artist-listeners`, `GET /discover/by-artist` */
export const ARTIST_QUERY_MAX_LENGTH = 255;

/** `GET /analytics/top-tracks-by-genre` */
export const GENRE_QUERY_MAX_LENGTH = 128;

/** `PATCH /auth/me`, register — aligned with `UserUpdate` / `UserCreate` */
export const PROFILE_USERNAME_MAX_LENGTH = 50;
export const PROFILE_EMAIL_MAX_LENGTH = 254;
export const PROFILE_BIO_MAX_LENGTH = 1000;
export const PROFILE_PASSWORD_MAX_LENGTH = 128;
export const PROFILE_AVATAR_URL_MAX_LENGTH = 500_000;

/** Reset token form + `ResetPasswordIn` */
export const RESET_TOKEN_MAX_LENGTH = 512;

/** `POST /playlists` — `PlaylistCreate` */
export const PLAYLIST_NAME_MAX_LENGTH = 255;
export const PLAYLIST_DESCRIPTION_MAX_LENGTH = 500;

/** Listen Together WS text (`sessions.py` truncates to 1000) */
export const SYNC_CHAT_TEXT_MAX_LENGTH = 1000;
/** Sticker URL line in WS (`sessions.py` 2000) */
export const SYNC_CHAT_STICKER_MAX_LENGTH = 2000;

/** `DiscoverCommentCreate` */
export const DISCOVER_COMMENT_MAX_LENGTH = 2000;

export function truncateUtf16(str: string, max: number): string {
  if (str.length <= max) {
    return str;
  }
  return str.slice(0, max);
}

export function normalizeSearchQuery(raw: unknown): string {
  const t = String(raw ?? "").trim();
  if (!t) {
    return "";
  }
  return truncateUtf16(t, SEARCH_QUERY_MAX_LENGTH);
}

/** Artist string in API query params (listeners, discover clips, iTunes analytics). */
export function normalizeArtistQueryParam(raw: unknown): string {
  const t = String(raw ?? "").trim();
  if (!t) {
    return "";
  }
  return truncateUtf16(t, ARTIST_QUERY_MAX_LENGTH);
}

export function normalizeGenreQueryParam(raw: unknown): string {
  const t = String(raw ?? "").trim();
  if (!t) {
    return "";
  }
  return truncateUtf16(t, GENRE_QUERY_MAX_LENGTH);
}

export function normalizeProfileUsername(raw: unknown): string {
  return truncateUtf16(String(raw ?? "").trim(), PROFILE_USERNAME_MAX_LENGTH);
}

export function normalizeProfileEmail(raw: unknown): string {
  return truncateUtf16(String(raw ?? "").trim(), PROFILE_EMAIL_MAX_LENGTH);
}

export function normalizeProfileBio(raw: unknown): string {
  return truncateUtf16(String(raw ?? "").trim(), PROFILE_BIO_MAX_LENGTH);
}

export function normalizeAuthPassword(raw: unknown): string {
  return truncateUtf16(String(raw ?? ""), PROFILE_PASSWORD_MAX_LENGTH);
}

export function normalizeProfileAvatarUrl(raw: unknown): string {
  return truncateUtf16(String(raw ?? "").trim(), PROFILE_AVATAR_URL_MAX_LENGTH);
}

export function normalizeResetToken(raw: unknown): string {
  return truncateUtf16(String(raw ?? "").trim(), RESET_TOKEN_MAX_LENGTH);
}

export function normalizePlaylistName(raw: unknown): string {
  return truncateUtf16(String(raw ?? "").trim(), PLAYLIST_NAME_MAX_LENGTH);
}

export function normalizePlaylistDescription(raw: unknown): string {
  return truncateUtf16(String(raw ?? "").trim(), PLAYLIST_DESCRIPTION_MAX_LENGTH);
}

export function normalizeDiscoverCommentBody(raw: unknown): string {
  return truncateUtf16(String(raw ?? "").trim(), DISCOVER_COMMENT_MAX_LENGTH);
}

export function normalizeSyncChatText(raw: unknown): string {
  return truncateUtf16(String(raw ?? "").trim(), SYNC_CHAT_TEXT_MAX_LENGTH);
}

export function normalizeSyncChatStickerUrl(raw: unknown): string {
  return truncateUtf16(String(raw ?? "").trim(), SYNC_CHAT_STICKER_MAX_LENGTH);
}
