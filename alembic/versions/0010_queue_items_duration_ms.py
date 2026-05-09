"""Add duration_ms to queue_items

Revision ID: 0010_queue_duration
Revises: 0009_songs_trgm
Create Date: 2026-03-29
"""

import sqlalchemy as sa
from alembic import op

revision = "0010_queue_duration"
down_revision = "0009_songs_trgm"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("queue_items", sa.Column("duration_ms", sa.Integer(), nullable=True))
    op.execute(
        """
        UPDATE queue_items
        SET duration_ms = (
            SELECT songs.duration_ms FROM songs WHERE songs.id = queue_items.song_id
        )
        WHERE song_id IS NOT NULL
        """
    )


def downgrade() -> None:
    op.drop_column("queue_items", "duration_ms")

