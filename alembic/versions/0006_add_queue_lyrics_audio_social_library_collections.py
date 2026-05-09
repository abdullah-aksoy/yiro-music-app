"""add queue, audio preferences, social follows and library collections

Revision ID: 0006_feature_domains
Revises: 0005_history_snapshot
Create Date: 2026-03-02 12:00:00
"""

from alembic import op
import sqlalchemy as sa


revision = "0006_feature_domains"
down_revision = "0005_history_snapshot"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "audio_preferences",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("volume", sa.Float(), nullable=False, server_default="0.9"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("user_id", name="uq_audio_preferences_user_id"),
    )
    op.create_index("ix_audio_preferences_user_id", "audio_preferences", ["user_id"], unique=False)
    op.create_check_constraint("ck_audio_preferences_volume_range", "audio_preferences", "volume >= 0 and volume <= 1")

    op.create_table(
        "queue_items",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("song_id", sa.Integer(), sa.ForeignKey("songs.id", ondelete="SET NULL"), nullable=True),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("artist", sa.String(length=255), nullable=False),
        sa.Column("album", sa.String(length=255), nullable=True),
        sa.Column("artwork_url", sa.String(length=1024), nullable=True),
        sa.Column("preview_url", sa.String(length=1024), nullable=True),
        sa.Column("is_local", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("file_path", sa.String(length=1024), nullable=True),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_queue_items_user_id", "queue_items", ["user_id"], unique=False)
    op.create_index("ix_queue_items_user_id_position", "queue_items", ["user_id", "position"], unique=False)
    op.create_check_constraint("ck_queue_items_position_nonnegative", "queue_items", "position >= 0")

    op.create_table(
        "saved_artists",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("artist_name", sa.String(length=255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("user_id", "artist_name", name="uq_saved_artists_user_artist"),
    )
    op.create_index("ix_saved_artists_user_id_created_at", "saved_artists", ["user_id", "created_at"], unique=False)

    op.create_table(
        "saved_albums",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("album_title", sa.String(length=255), nullable=False),
        sa.Column("artist_name", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("user_id", "album_title", "artist_name", name="uq_saved_albums_user_album_artist"),
    )
    op.create_index("ix_saved_albums_user_id_created_at", "saved_albums", ["user_id", "created_at"], unique=False)

    op.create_table(
        "user_follows",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("follower_user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("followed_user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("follower_user_id", "followed_user_id", name="uq_user_follows_pair"),
    )
    op.create_index("ix_user_follows_follower_created_at", "user_follows", ["follower_user_id", "created_at"], unique=False)
    op.create_check_constraint("ck_user_follows_not_self", "user_follows", "follower_user_id <> followed_user_id")

    op.alter_column("audio_preferences", "volume", server_default=None)
    op.alter_column("queue_items", "is_local", server_default=None)
    op.alter_column("queue_items", "position", server_default=None)


def downgrade() -> None:
    op.drop_constraint("ck_user_follows_not_self", "user_follows", type_="check")
    op.drop_index("ix_user_follows_follower_created_at", table_name="user_follows")
    op.drop_table("user_follows")

    op.drop_index("ix_saved_albums_user_id_created_at", table_name="saved_albums")
    op.drop_table("saved_albums")

    op.drop_index("ix_saved_artists_user_id_created_at", table_name="saved_artists")
    op.drop_table("saved_artists")

    op.drop_constraint("ck_queue_items_position_nonnegative", "queue_items", type_="check")
    op.drop_index("ix_queue_items_user_id_position", table_name="queue_items")
    op.drop_index("ix_queue_items_user_id", table_name="queue_items")
    op.drop_table("queue_items")

    op.drop_constraint("ck_audio_preferences_volume_range", "audio_preferences", type_="check")
    op.drop_index("ix_audio_preferences_user_id", table_name="audio_preferences")
    op.drop_table("audio_preferences")

