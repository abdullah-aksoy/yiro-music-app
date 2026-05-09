"""Upper bounds for user-controlled strings and list payloads (API hardening, aligns with frontend)."""

# --- Query params (see also frontend queryLimits.ts) ---
SEARCH_QUERY_MAX = 256
ARTIST_QUERY_MAX = 255
GENRE_QUERY_MAX = 128

# --- Song / iTunes metadata ---
SONG_TITLE_MAX = 512
SONG_ARTIST_MAX = 512
SONG_ALBUM_MAX = 512
SONG_GENRE_MAX = 128
ITUNES_TRACK_ID_MAX = 32

# --- URLs & paths ---
MEDIA_URL_MAX = 2048
LOCAL_FILE_PATH_MAX = 2048

# --- Auth ---
EMAIL_INPUT_MAX = 254  # RFC 5321 path limit
JWT_QUERY_TOKEN_MAX = 4096

# --- User profile (User.username) ---
USERNAME_MAX = 50

# --- List bodies (abuse / DoS guardrails) ---
SONG_RELATIONS_BATCH_MAX = 50
QUEUE_REORDER_ITEM_IDS_MAX = 2000
PLAYLIST_REORDER_SONG_IDS_MAX = 5000

# --- HTTP / WebSocket ---
# Typical JSON + multipart; streaming uploads without Content-Length are not pre-checked.
HTTP_MAX_CONTENT_LENGTH_BYTES = 2_097_152  # 2 MiB

# Listen Together non-text chat payload (e.g. base64 voice); keep bounded vs. old 2M ceiling.
LISTEN_WS_VOICE_CONTENT_MAX = 512_000

# OAuth2 auxiliary form fields (client metadata).
OAUTH2_CLIENT_FIELD_MAX = 256
