"""add history snapshot fields for non-local listens

Revision ID: 0005_history_snapshot
Revises: 0004_playlist_follows
Create Date: 2026-02-27 03:10:00
"""

from alembic import op
import sqlalchemy as sa


revision = "0005_history_snapshot"
down_revision = "0004_playlist_follows"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("listening_history", "song_id", existing_type=sa.Integer(), nullable=True)
    op.add_column(
        "listening_history",
        sa.Column("source_type", sa.String(length=16), nullable=False, server_default="local"),
    )
    op.add_column("listening_history", sa.Column("track_title", sa.String(length=255), nullable=True))
    op.add_column("listening_history", sa.Column("track_artist", sa.String(length=255), nullable=True))
    op.add_column("listening_history", sa.Column("track_album", sa.String(length=255), nullable=True))
    op.add_column("listening_history", sa.Column("track_genre", sa.String(length=100), nullable=True))
    op.add_column("listening_history", sa.Column("track_duration_ms", sa.Integer(), nullable=True))
    op.add_column("listening_history", sa.Column("track_artwork_url", sa.String(length=1024), nullable=True))
    op.add_column("listening_history", sa.Column("track_preview_url", sa.String(length=1024), nullable=True))
    op.add_column("listening_history", sa.Column("track_itunes_id", sa.String(length=64), nullable=True))
    op.create_index(
        "ix_listening_history_user_id_source_type_listened_at",
        "listening_history",
        ["user_id", "source_type", "listened_at"],
        unique=False,
    )
    op.create_check_constraint(
        "ck_listening_history_source_type_valid",
        "listening_history",
        "source_type in ('local', 'itunes')",
    )
    op.alter_column("listening_history", "source_type", server_default=None)


def downgrade() -> None:
    op.drop_constraint("ck_listening_history_source_type_valid", "listening_history", type_="check")
    op.drop_index("ix_listening_history_user_id_source_type_listened_at", table_name="listening_history")
    op.drop_column("listening_history", "track_itunes_id")
    op.drop_column("listening_history", "track_preview_url")
    op.drop_column("listening_history", "track_artwork_url")
    op.drop_column("listening_history", "track_duration_ms")
    op.drop_column("listening_history", "track_genre")
    op.drop_column("listening_history", "track_album")
    op.drop_column("listening_history", "track_artist")
    op.drop_column("listening_history", "track_title")
    op.drop_column("listening_history", "source_type")
    op.alter_column("listening_history", "song_id", existing_type=sa.Integer(), nullable=False)
