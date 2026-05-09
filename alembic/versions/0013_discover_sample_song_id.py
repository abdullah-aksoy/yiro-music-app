"""Link discover_samples to canonical songs table.

Revision ID: 0013_discover_sample_song_id
Revises: 0012_discover_samples
Create Date: 2026-04-02
"""

import sqlalchemy as sa
from alembic import op

revision = "0013_discover_sample_song_id"
down_revision = "0012_discover_samples"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "discover_samples",
        sa.Column("song_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_discover_samples_song_id",
        "discover_samples",
        "songs",
        ["song_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_discover_samples_song_id", "discover_samples", ["song_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_discover_samples_song_id", table_name="discover_samples")
    op.drop_constraint("fk_discover_samples_song_id", "discover_samples", type_="foreignkey")
    op.drop_column("discover_samples", "song_id")
