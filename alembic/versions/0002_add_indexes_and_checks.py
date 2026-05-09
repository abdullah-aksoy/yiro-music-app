"""add indexes and check constraints

Revision ID: 0002_add_indexes_and_checks
Revises: 0001_initial_schema
Create Date: 2026-02-27 00:00:00
"""

from alembic import op


revision = "0002_add_indexes_and_checks"
down_revision = "0001_initial_schema"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_playlists_user_id_created_at",
        "playlists",
        ["user_id", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_playlist_songs_playlist_id_position",
        "playlist_songs",
        ["playlist_id", "position"],
        unique=False,
    )
    op.create_index(
        "ix_favorites_user_id_created_at",
        "favorites",
        ["user_id", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_listening_history_user_id_listened_at",
        "listening_history",
        ["user_id", "listened_at"],
        unique=False,
    )
    # Ensure legacy/seeded negative values do not block check constraint creation.
    op.execute("UPDATE playlist_songs SET position = 0 WHERE position < 0")
    op.execute("UPDATE listening_history SET listened_duration_ms = 0 WHERE listened_duration_ms < 0")
    op.create_check_constraint(
        "ck_playlist_songs_position_nonnegative",
        "playlist_songs",
        "position >= 0",
    )
    op.create_check_constraint(
        "ck_listening_history_duration_nonnegative",
        "listening_history",
        "listened_duration_ms >= 0",
    )


def downgrade() -> None:
    op.drop_constraint("ck_listening_history_duration_nonnegative", "listening_history", type_="check")
    op.drop_constraint("ck_playlist_songs_position_nonnegative", "playlist_songs", type_="check")
    op.drop_index("ix_listening_history_user_id_listened_at", table_name="listening_history")
    op.drop_index("ix_favorites_user_id_created_at", table_name="favorites")
    op.drop_index("ix_playlist_songs_playlist_id_position", table_name="playlist_songs")
    op.drop_index("ix_playlists_user_id_created_at", table_name="playlists")
