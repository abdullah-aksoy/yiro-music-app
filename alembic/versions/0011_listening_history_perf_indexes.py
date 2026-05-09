"""Indexes for global history aggregates and orphan rows (trending / co-occurrence).

Revision ID: 0011_history_perf_idx
Revises: 0010_queue_duration
Create Date: 2026-04-02
"""

import sqlalchemy as sa
from alembic import op

revision = "0011_history_perf_idx"
down_revision = "0010_queue_duration"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_listening_history_listened_at",
        "listening_history",
        ["listened_at"],
        unique=False,
    )
    op.create_index(
        "ix_listening_history_song_id_listened_at",
        "listening_history",
        ["song_id", "listened_at"],
        unique=False,
        postgresql_where=sa.text("song_id IS NOT NULL"),
    )
    op.execute(
        "CREATE INDEX ix_listening_history_orphan_listened_at "
        "ON listening_history (listened_at DESC) WHERE song_id IS NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_listening_history_orphan_listened_at")
    op.drop_index("ix_listening_history_song_id_listened_at", table_name="listening_history")
    op.drop_index("ix_listening_history_listened_at", table_name="listening_history")
