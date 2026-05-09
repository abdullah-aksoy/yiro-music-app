"""initial schema

Revision ID: 0001_initial_schema
Revises:
Create Date: 2026-02-26 00:00:00
"""

from alembic import op
import sqlalchemy as sa


revision = "0001_initial_schema"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("username", sa.String(length=50), nullable=False, unique=True),
        sa.Column("email", sa.String(length=255), nullable=False, unique=True),
        sa.Column("hashed_password", sa.String(length=255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_users_id", "users", ["id"])
    op.create_index("ix_users_username", "users", ["username"])
    op.create_index("ix_users_email", "users", ["email"])

    op.create_table(
        "songs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("artist", sa.String(length=255), nullable=False),
        sa.Column("album", sa.String(length=255), nullable=True),
        sa.Column("genre", sa.String(length=100), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("file_path", sa.String(length=1024), nullable=True),
        sa.Column("artwork_url", sa.String(length=1024), nullable=True),
        sa.Column("itunes_track_id", sa.String(length=64), nullable=True, unique=True),
        sa.Column("preview_url", sa.String(length=1024), nullable=True),
        sa.Column("is_local", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_songs_id", "songs", ["id"])
    op.create_index("ix_songs_title", "songs", ["title"])
    op.create_index("ix_songs_artist", "songs", ["artist"])
    op.create_index("ix_songs_genre", "songs", ["genre"])

    op.create_table(
        "playlists",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.String(length=500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_playlists_id", "playlists", ["id"])

    op.create_table(
        "playlist_songs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("playlist_id", sa.Integer(), sa.ForeignKey("playlists.id", ondelete="CASCADE"), nullable=False),
        sa.Column("song_id", sa.Integer(), sa.ForeignKey("songs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("added_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("playlist_id", "song_id", name="uq_playlist_song"),
    )
    op.create_index("ix_playlist_songs_id", "playlist_songs", ["id"])

    op.create_table(
        "favorites",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("song_id", sa.Integer(), sa.ForeignKey("songs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("user_id", "song_id", name="uq_user_favorite_song"),
    )
    op.create_index("ix_favorites_id", "favorites", ["id"])

    op.create_table(
        "listening_history",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("song_id", sa.Integer(), sa.ForeignKey("songs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("listened_duration_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("listened_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_listening_history_id", "listening_history", ["id"])
    op.create_index("ix_listening_history_user_id", "listening_history", ["user_id"])
    op.create_index("ix_listening_history_song_id", "listening_history", ["song_id"])


def downgrade() -> None:
    op.drop_index("ix_listening_history_song_id", table_name="listening_history")
    op.drop_index("ix_listening_history_user_id", table_name="listening_history")
    op.drop_index("ix_listening_history_id", table_name="listening_history")
    op.drop_table("listening_history")

    op.drop_index("ix_favorites_id", table_name="favorites")
    op.drop_table("favorites")

    op.drop_index("ix_playlist_songs_id", table_name="playlist_songs")
    op.drop_table("playlist_songs")

    op.drop_index("ix_playlists_id", table_name="playlists")
    op.drop_table("playlists")

    op.drop_index("ix_songs_genre", table_name="songs")
    op.drop_index("ix_songs_artist", table_name="songs")
    op.drop_index("ix_songs_title", table_name="songs")
    op.drop_index("ix_songs_id", table_name="songs")
    op.drop_table("songs")

    op.drop_index("ix_users_email", table_name="users")
    op.drop_index("ix_users_username", table_name="users")
    op.drop_index("ix_users_id", table_name="users")
    op.drop_table("users")

