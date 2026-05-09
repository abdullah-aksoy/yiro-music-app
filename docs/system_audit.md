# System Audit Baseline

## Frontend

- Stack: plain static `index.html` + `style.css` + `app.js`.
- Entry points:
  - `app/static/index.html`
  - `app/static/style.css`
  - `app/static/app.js`
- Main app pattern:
  - Global `el` DOM refs object.
  - Global `state` object with auth/session/data/player fields.
  - Render + fetch + event-binding all in a single file.
- Existing primary views:
  - `searchView`, `artistDetailView`, `playlistsView`, `favoritesView`, `historyView`.
- Existing player:
  - Single `<audio>` element (`#audioPlayer`), play/pause button, progress + time labels.
  - No native queue, next/prev, repeat/shuffle controls.
- Existing offline layer:
  - Service worker in `app/static/sw.js`.
  - Stream caching is available but intentionally minimal by default.

## Backend

- Stack: FastAPI + SQLAlchemy async + Alembic.
- App entry:
  - `app/main.py` mounts routers under `/api` and UI under `/ui`.
- Existing domains:
  - `auth`, `songs`, `search`, `stream`, `playlists`, `favorites`, `history`,
    `library`, `analytics`, `sync`, `notifications`, `users_public`.
- Existing social baseline:
  - Public playlists, follow/unfollow playlists, following feed, derived notifications.
- Existing data models:
  - `User`, `Song`, `Playlist`, `PlaylistSong`, `PlaylistFollow`, `Favorite`, `ListeningHistory`.

## Current Gaps (Before This Implementation)

- Queue: no dedicated backend queue model/API.
- Lyrics: no model/API and no frontend panel.
- Audio preferences: no per-user persisted settings.
- Library expansion: no saved artist/album entities.
- Social expansion: no user-follow graph.

