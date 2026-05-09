"""drop redundant indexes

Revision ID: 0003_drop_redundant_indexes
Revises: 0002_add_indexes_and_checks
Create Date: 2026-02-27 00:30:00
"""

from alembic import op


revision = "0003_drop_redundant_indexes"
down_revision = "0002_add_indexes_and_checks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_users_id")
    op.execute("DROP INDEX IF EXISTS ix_users_username")
    op.execute("DROP INDEX IF EXISTS ix_users_email")
    op.execute("DROP INDEX IF EXISTS ix_songs_id")
    op.execute("DROP INDEX IF EXISTS ix_playlists_id")
    op.execute("DROP INDEX IF EXISTS ix_playlist_songs_id")
    op.execute("DROP INDEX IF EXISTS ix_favorites_id")
    op.execute("DROP INDEX IF EXISTS ix_listening_history_id")


def downgrade() -> None:
    op.create_index("ix_users_id", "users", ["id"], unique=False)
    op.create_index("ix_users_username", "users", ["username"], unique=False)
    op.create_index("ix_users_email", "users", ["email"], unique=False)
    op.create_index("ix_songs_id", "songs", ["id"], unique=False)
    op.create_index("ix_playlists_id", "playlists", ["id"], unique=False)
    op.create_index("ix_playlist_songs_id", "playlist_songs", ["id"], unique=False)
    op.create_index("ix_favorites_id", "favorites", ["id"], unique=False)
    op.create_index("ix_listening_history_id", "listening_history", ["id"], unique=False)
