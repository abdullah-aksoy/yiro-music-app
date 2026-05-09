"""add playlist visibility and follows

Revision ID: 0004_playlist_follows
Revises: 0003_drop_redundant_indexes
Create Date: 2026-02-27 01:10:00
"""

from alembic import op
import sqlalchemy as sa


revision = "0004_playlist_follows"
down_revision = "0003_drop_redundant_indexes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("playlists", sa.Column("is_public", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column("playlists", sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()))
    op.create_index("ix_playlists_public_created_at", "playlists", ["is_public", "created_at"], unique=False)

    op.create_table(
        "playlist_follows",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("playlist_id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["playlist_id"], ["playlists.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "playlist_id", name="uq_playlist_follows_user_playlist"),
    )
    op.create_index(
        "ix_playlist_follows_user_id_created_at",
        "playlist_follows",
        ["user_id", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_playlist_follows_playlist_id_created_at",
        "playlist_follows",
        ["playlist_id", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_playlist_follows_playlist_id_created_at", table_name="playlist_follows")
    op.drop_index("ix_playlist_follows_user_id_created_at", table_name="playlist_follows")
    op.drop_table("playlist_follows")

    op.drop_index("ix_playlists_public_created_at", table_name="playlists")
    op.drop_column("playlists", "updated_at")
    op.drop_column("playlists", "is_public")
